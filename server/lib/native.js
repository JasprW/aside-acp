import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolveAsideCli } from "./aside.js";

const clients = new Map();
const TIMEOUT_MS = 10000;

function daemonOrigin() {
  const variant = process.env.ASIDE_PRODUCT_VARIANT || "stable";
  if (!["stable", "canary"].includes(variant)) throw new Error("Invalid ASIDE_PRODUCT_VARIANT");
  const url = new URL(process.env.DAEMON_BASE_URL || `http://127.0.0.1:${variant === "canary" ? 21421 : 21420}`);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("Aside permissions require the local loopback daemon");
  }
  return url.origin;
}

/** Let the signed CLI authenticate using its own Keychain entitlements.
 * The temporary loopback relay forwards only the CLI's read-only account
 * handshake to the selected daemon and retains its issued token in memory.
 * It never loads native modules into Electron, reads keys or changes signatures.
 */
async function authorizeViaCli(cli, origin) {
  let authorization = null;
  let relayError = null;
  const relay = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url || "/", origin);
      const allowed = (request.method === "GET" && [
        "/auth/daemon/challenge", "/auth/daemon/verify", "/trpc/accounts.summary",
      ].includes(url.pathname)) || (request.method === "POST" && url.pathname === "/auth/daemon/session");
      if (!allowed) { response.writeHead(403); response.end("Unsupported Aside authentication route"); return; }
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString("utf8");
        if (body.length > 16384) throw new Error("Oversized Aside authentication request");
      }
      const headers = { "content-type": "application/json" };
      if (typeof request.headers.authorization === "string") headers.authorization = request.headers.authorization;
      const upstream = await fetch(new URL(url.pathname + url.search, origin), {
        method: request.method, headers, ...(body ? { body } : {}),
        redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await upstream.text();
      if (upstream.ok && url.pathname === "/auth/daemon/session") {
        const result = JSON.parse(text);
        if (typeof result.access_token !== "string" || !Number.isFinite(result.expiresInSeconds)) {
          throw new Error("Invalid Aside CLI authentication response");
        }
        authorization = { token: result.access_token, expiresAt: Date.now() + result.expiresInSeconds * 1000 };
      }
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
      response.end(text);
    })().catch((error) => {
      relayError = error;
      if (!response.headersSent) response.writeHead(502);
      response.end("Aside authentication relay failed");
    });
  });
  try {
    await new Promise((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", resolve);
    });
    const address = relay.address();
    if (!address || typeof address === "string") throw new Error("Cannot start Aside CLI authentication relay");
    const env = { ...process.env, DAEMON_BASE_URL: `http://127.0.0.1:${address.port}`, ASIDE_CLI_UPDATE_CHECK: "0" };
    delete env.DAEMON_AUTH_JWT;
    const child = spawn(cli, ["account", "status"], { env, stdio: ["ignore", "ignore", "pipe"] });
    await new Promise((resolve, reject) => {
      let stderr = "";
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("Aside CLI authentication timed out"));
      }, TIMEOUT_MS * 2);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-4096); });
      child.on("error", (error) => finish(new Error(`Cannot start Aside CLI for authentication: ${error.message}`)));
      child.on("close", (code) => {
        if (code !== 0 || !authorization) finish(new Error(`Aside CLI authentication failed: ${relayError?.message || stderr.trim() || "CLI did not establish a daemon session"}`));
        else finish();
      });
    });
    return authorization;
  } finally {
    relay.closeAllConnections();
    await new Promise((resolve) => relay.close(resolve));
  }
}

class NativeClient {
  constructor(origin, cli) {
    this.origin = origin;
    this.cli = cli;
    this.token = null;
    this.expiresAt = 0;
    this.authorizing = null;
  }

  async fetch(url, init = {}) {
    // Never follow a redirect with the daemon's credentials.
    return fetch(new URL(url, this.origin), { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  async authorize() {
    if (process.env.DAEMON_AUTH_JWT) return process.env.DAEMON_AUTH_JWT;
    if (this.token && Date.now() < this.expiresAt - 30000) return this.token;
    if (!this.authorizing) this.authorizing = (async () => {
      const authorization = await authorizeViaCli(this.cli, this.origin);
      this.token = authorization.token;
      this.expiresAt = authorization.expiresAt;
      return this.token;
    })().finally(() => { this.authorizing = null; });
    return this.authorizing;
  }

  async call(procedure, input, mutation = false) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.authorize();
      const url = `/trpc/${procedure}${mutation ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;
      const response = await this.fetch(url, {
        method: mutation ? "POST" : "GET",
        headers: { "content-type": "application/json", Authorization: `AsideDaemonSessionToken ${token}` },
        ...(mutation ? { body: JSON.stringify(input) } : {}),
      });
      // A 401 cannot have performed the mutation. Never retry an ambiguous
      // network failure or an approval whose response might already be stored.
      if (response.status === 401 && attempt === 0 && !process.env.DAEMON_AUTH_JWT) {
        this.token = null;
        continue;
      }
      const body = await response.json();
      if (!response.ok || body.error) throw new Error(`Aside ${procedure}: ${body.error?.message || `HTTP ${response.status}`}`);
      if (!body.result || !("data" in body.result)) throw new Error(`Invalid Aside ${procedure} response`);
      return body.result.data;
    }
    throw new Error("Aside daemon authentication expired");
  }

  getSession(accountId, sessionId) {
    return this.call("sessions.get", { accountId, sessionId });
  }

  updatePermissions(accountId, sessionId, permissionMode, finalConfirm) {
    return this.call("sessions.update", { accountId, sessionId,
      ...(permissionMode ? { permissionMode } : {}), runtimeConfig: { finalConfirm } }, true);
  }

  resolveSuspension(accountId, sessionId, suspension, response) {
    return this.call("sessions.resolveSuspension", {
      accountId, sessionId, toolCallId: suspension.toolCallId,
      ...(suspension.id ? { suspensionId: suspension.id } : {}), response,
    }, true);
  }
}

/** A memory-only authenticated client for the user's local Aside daemon. */
export function getNativeClient(config) {
  const origin = daemonOrigin();
  const cli = resolveAsideCli(config);
  const key = `${origin}\0${cli}`;
  if (!clients.has(key)) clients.set(key, new NativeClient(origin, cli));
  return clients.get(key);
}

export function activeSuspension(session) {
  const suspension = session?.suspension;
  if (!suspension || suspension.response != null || suspension.error != null || suspension.resolvedAt != null) return null;
  if (!["approval", "action-confirmation", "ask-user-question"].includes(suspension.kind) || typeof suspension.toolCallId !== "string") return null;
  return suspension;
}

export function suspensionKey(suspension) {
  return JSON.stringify([suspension.id ?? null, suspension.kind, suspension.toolCallId, suspension.createdAt, suspension.request]);
}
