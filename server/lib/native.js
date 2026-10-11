import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
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

function loadNativeHelper(cli) {
  const executable = fs.realpathSync(cli);
  // Paseo bundles server plugins as CJS, where import.meta.url is unavailable.
  // Absolute native addon paths can be loaded with the installed CLI as anchor.
  const require = createRequire(executable);
  const dir = path.dirname(executable);
  const paths = [process.env.ASIDE_NATIVE_HELPER_BINDING,
    path.resolve(dir, "../Resources/native/aside-native.node"),
    path.resolve(dir, "native/aside-native.node")].filter(Boolean);
  for (const file of paths) {
    if (!fs.existsSync(file)) continue;
    try {
      const binding = require(file);
      if (typeof binding.run === "function") return binding;
    } catch { /* try the next installed helper */ }
  }
  throw new Error("Aside native authentication helper is unavailable. Update the installed Aside CLI, then reload the plugin.");
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
      const challengeResponse = await this.fetch("/auth/daemon/challenge?clientKind=cli");
      if (!challengeResponse.ok) throw new Error(`Aside daemon authentication challenge failed (${challengeResponse.status})`);
      const { challenge, challengeId } = await challengeResponse.json();
      if (typeof challenge !== "string" || typeof challengeId !== "string") throw new Error("Invalid Aside authentication challenge");
      // Use Aside's installed helper and existing OS-user key, just like its CLI.
      // Neither keys nor tokens are written into plugin configuration or logs.
      this.binding ??= loadNativeHelper(this.cli);
      const bytes = Buffer.concat([Buffer.from("Aside Daemon Auth v1\0"), Buffer.from(challenge, "base64")]);
      const signature = JSON.parse(this.binding.run("cdp-sign", JSON.stringify({ challenge: bytes.toString("base64") })));
      if (typeof signature.signature !== "string") throw new Error("Aside native helper could not authenticate the local daemon");
      const response = await this.fetch("/auth/daemon/session", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ challengeId, signedChallenge: signature.signature }),
      });
      if (!response.ok) throw new Error(`Aside daemon authentication failed (${response.status})`);
      const body = await response.json();
      if (typeof body.access_token !== "string" || !Number.isFinite(body.expiresInSeconds)) throw new Error("Invalid Aside daemon authentication response");
      this.token = body.access_token;
      this.expiresAt = Date.now() + body.expiresInSeconds * 1000;
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
