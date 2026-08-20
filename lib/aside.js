// aside-acp: aside CLI wrapper — spawn exec, detect sessions, read transcripts.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s) {
  return String(s || "").replace(ANSI_RE, "");
}

// --- config / paths -------------------------------------------------------

export function loadConfig() {
  const cfgPath =
    process.env.ASIDE_ACP_CONFIG ||
    path.join(os.homedir(), ".aside-acp.json");
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    /* absent or unparsable → defaults */
  }
  const config = {
    aside_cli: process.env.ASIDE_ACP_CLI || file.aside_cli || "",
    account: file.account ?? null,
    owner_name: file.owner_name || "the owner",
    default_model: file.default_model || "",
    default_effort: file.default_effort || "medium",
    exec_timeout_seconds: Number(file.exec_timeout_seconds || 1200),
    style: file.style || "formal",
    grant_full_access: file.grant_full_access !== false,
    approved_models: file.approved_models ?? null,
  };
  return config;
}

export function detectAccountRoot(account = null) {
  const asideHome = process.env.ASIDE_HOME || path.join(os.homedir(), ".aside");
  if (account !== null && account !== undefined) {
    return path.join(asideHome, `u/${account}`);
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(asideHome, "accounts.json"), "utf8"),
    );
    const current = parsed?.currentAccountId;
    if (typeof current === "number" && Number.isInteger(current) && current >= 0) {
      return path.join(asideHome, `u/${current}`);
    }
  } catch {
    /* fall through */
  }
  return path.join(asideHome, "u/0");
}

export function resolveAsideCli(config) {
  const candidates = [];
  if (config.aside_cli) candidates.push(config.aside_cli);
  if (process.env.ASIDE_ACP_CLI) candidates.push(process.env.ASIDE_ACP_CLI);
  candidates.push(
    "aside", // PATH
    path.join(os.homedir(), ".aside/cli/Aside CLI.app/Contents/MacOS/aside"),
    path.join(os.homedir(), ".local/bin/aside"),
  );
  for (const c of candidates) {
    if (!c) continue;
    if (c === "aside") {
      // resolve via PATH manually so we can report the actual path
      const found = which("aside");
      if (found) return found;
      continue;
    }
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* keep looking */
    }
  }
  throw new Error(
    "aside CLI not found. Set aside_cli in ~/.aside-acp.json or ASIDE_ACP_CLI.",
  );
}

function which(bin) {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of dirs) {
    const p = path.join(dir, bin);
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// --- spawning --------------------------------------------------------------

export function execAsync(cli, args, { timeoutMs = 1200000, log = () => {} } = {}) {
  return new Promise((resolve) => {
    log(`exec: ${cli} ${args.join(" ")}`);
    const t0 = Date.now();
    let child;
    try {
      child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, stdout: "", stderr: String(e), timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on("error", (e) => {
      stderr += `\nspawn error: ${e.message}`;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      log(`exec done exit=${code} in ${Date.now() - t0}ms${timedOut ? " (TIMEOUT)" : ""}`);
      resolve({
        code,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
        timedOut,
      });
    });
  });
}

export function killTree(child) {
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  // escalate after a short grace period — aside exec is a wrapper, it has
  // no state to flush, so don't linger on a slow SIGTERM
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, 1000);
}

export function grantFullAccess(cli, sid, log = () => {}, account = null) {
  try {
    const args = ["repl"];
    if (account !== null && account !== undefined) {
      args.push("--account", String(account));
    }
    args.push(
      `aside.sessions.update('${sid}', { permissionMode: 'full-access' })`,
    );
    const r = spawnSync(cli, args, { encoding: "utf8", timeout: 30000 });
    log(`grant full-access ${sid}: exit=${r.status} ${stripAnsi(r.stderr || "").slice(0, 200)}`);
    return r.status === 0;
  } catch (e) {
    log(`grant full-access failed: ${e.message}`);
    return false;
  }
}

// --- session discovery -----------------------------------------------------

export function sessionsDir(accountRoot) {
  return path.join(accountRoot, "sessions");
}

/**
 * Resolve a session id (the suffix after `<date>_`) to its directory.
 * Accepts the full dir name too, for robustness.
 */
export function sessionDir(accountRoot, sid) {
  const dir = sessionsDir(accountRoot);
  if (fs.existsSync(path.join(dir, sid))) return path.join(dir, sid);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(`_${sid}`)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) return full;
      }
    }
  } catch {
    /* fall through */
  }
  return path.join(dir, sid);
}

export function transcriptPath(accountRoot, sid) {
  return path.join(sessionDir(accountRoot, sid), "messages.jsonl");
}

/**
 * Newest session directory (name <date>_<id>), optionally after a point in
 * time and/or containing a marker string in messages.jsonl.
 */
export function findNewestSession(
  accountRoot,
  { newerThanMs = 0, mustContain = null, log = () => {} } = {},
) {
  const dir = sessionsDir(accountRoot);
  let best = null;
  let bestM = 0;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory() || !name.includes("_")) continue;
    const m = st.mtimeMs;
    if (m <= Math.max(bestM, newerThanMs)) continue;
    if (mustContain) {
      const tf = path.join(full, "messages.jsonl");
      let txt;
      try {
        txt = fs.readFileSync(tf, "utf8");
      } catch {
        continue;
      }
      if (!txt.toLowerCase().includes(mustContain.toLowerCase())) continue;
    }
    best = full;
    bestM = m;
  }
  return best ? best.slice(best.lastIndexOf("_") + 1) : null;
}

// --- transcript reader -----------------------------------------------------

/**
 * Incremental reader over a session's messages.jsonl.
 * Tracks a byte offset; each read() returns assistant text parts and provider
 * error rows that are new since the previous read. Dedupes by
 * (responseId, contentIndex) so transcript rewrites never double-emit.
 */
export class TranscriptReader {
  constructor(accountRoot, sid, log = () => {}) {
    this.accountRoot = accountRoot;
    this.sid = sid;
    this.log = log;
    this.path = transcriptPath(accountRoot, sid);
    this.offset = 0;
    this.seen = new Set();
    this.ready = false;
  }

  open(initialOffset = null) {
    try {
      if (fs.existsSync(this.path)) {
        const st = fs.statSync(this.path);
        this.offset = initialOffset === null ? st.size : Math.min(initialOffset, st.size);
        this.lastSize = st.size;
        this.ready = true;
      }
    } catch (e) {
      this.log(`transcript open failed: ${e.message}`);
    }
    return this.ready;
  }

  /**
   * Read new content. Returns:
   *   { parts: [{responseId, text}], errors: [errorMessage], complete }
   * parts = assistant text parts not yet emitted (in order).
   *
   * Reads bytes (Buffer slice, not string slice — transcripts contain
   * multi-byte chars and string.slice() with a byte offset corrupts lines).
   * If the file is rewritten smaller (aside compaction), falls back to a
   * full re-read; the seen-set dedupes so nothing double-emits.
   */
  read() {
    const out = { parts: [], errors: [] };
    if (!this.ready || !fs.existsSync(this.path)) return out;
    let buf;
    try {
      const st = fs.statSync(this.path);
      if (st.size === this.lastSize && st.size <= this.offset) return out;
      buf = fs.readFileSync(this.path);
      this.lastSize = st.size;
    } catch (e) {
      this.log(`transcript read failed: ${e.message}`);
      return out;
    }
    const start = buf.length >= this.offset ? this.offset : 0; // rewrite → full scan
    const data = buf.toString("utf8", start);
    this.offset = buf.length;
    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue; // partial line while still being written
      }
      if (m.role !== "assistant") continue;
      // Only the FINAL assistant reply counts as output. Aside emits
      // step-by-step thinking text before each tool call; streaming that
      // pollutes Paseo's timeline with the agent's internal monologue.
      // ACP has no thinking/reasoning content type in this SDK version, so
      // intermediate assistant text is dropped entirely.
      if (!["stop", "end_turn"].includes(m.stopReason)) continue;
      const content = Array.isArray(m.content) ? m.content : [];
      content.forEach((c, i) => {
        if (!c || c.type !== "text" || typeof c.text !== "string") return;
        const key = `${m.responseId || m.timestamp || "?"}:${i}`;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        out.parts.push({ responseId: m.responseId, text: c.text });
      });
      if (m.stopReason === "error" && m.errorMessage) {
        out.errors.push(String(m.errorMessage));
      }
    }
    return out;
  }
}
