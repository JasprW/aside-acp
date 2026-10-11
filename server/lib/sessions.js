import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execAsync, detectAccountRoot, loadConfig, transcriptPath } from "./aside.js";
import { BOOTSTRAP_MARKER, buildReminder } from "./persona.js";

const NATIVE_PREFIX = "aside_native_";

function accountNumber(accountRoot) {
  const account = Number(path.basename(accountRoot));
  if (!Number.isInteger(account) || account < 0) throw new Error("Invalid Aside account directory");
  return account;
}

function validSid(sid) {
  if (typeof sid !== "string" || !/^[a-zA-Z0-9_-]+$/.test(sid)) throw new Error("Invalid Aside session ID");
  return sid;
}

export function parseNativeSessionId(sessionId, accountRoot) {
  if (!sessionId.startsWith(NATIVE_PREFIX)) return null;
  const match = /^aside_native_(\d+)_([a-zA-Z0-9_-]+)$/.exec(sessionId);
  if (!match || Number(match[1]) !== accountNumber(accountRoot)) {
    throw new Error("This Aside session belongs to a different account");
  }
  return validSid(match[2]);
}

async function querySessions(accountRoot, where) {
  const database = path.join(accountRoot, "state.db");
  if (!fs.existsSync(database)) throw new Error("Aside session index not found; start and sign in to Aside on this daemon machine");
  // macOS ships sqlite3. No native npm binding or database writes are needed.
  const sqlite = process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3";
  const query = `SELECT id, title, cwd, model, permission_mode, updated_at, created_at FROM sessions WHERE ${where} ORDER BY updated_at DESC, id ASC`;
  const result = await execAsync(sqlite, ["-readonly", "-json", "-cmd", ".timeout 5000", database, query], { timeoutMs: 15000 });
  if (result.timedOut || result.code !== 0) {
    throw new Error(`Cannot read Aside session index: ${result.stderr.trim() || "SQLite timed out"}`);
  }
  const rows = JSON.parse(result.stdout.trim() || "[]");
  if (!Array.isArray(rows)) throw new Error("Invalid Aside session index response");
  return rows;
}

function sessionCwd(row, accountRoot) {
  return typeof row.cwd === "string" && path.isAbsolute(row.cwd) ? path.resolve(row.cwd) : accountRoot;
}

function isoDate(value) {
  const millis = typeof value === "number" && value < 1e12 ? value * 1000 : value;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Shared by the ACP server and the Paseo wrapper (which also handles search). */
export async function listAsideSessions({ accountRoot, sessionsRoot, cwd, query, limit } = {}) {
  accountRoot ??= detectAccountRoot(loadConfig().account);
  sessionsRoot ??= path.join(os.homedir(), ".aside-acp", "sessions");
  const account = accountNumber(accountRoot);
  // Match Aside's visible history: root, non-archived, non-incognito, non-ephemeral.
  const rows = await querySessions(accountRoot, "parent_id IS NULL AND archived_at IS NULL AND COALESCE(incognito, 0) = 0 AND COALESCE(ephemeral, 0) = 0");
  const existing = new Map();
  if (fs.existsSync(sessionsRoot)) for (const name of fs.readdirSync(sessionsRoot).sort()) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(sessionsRoot, name), "utf8"));
      if (saved.account == null || Number(saved.account) !== account || !saved.asideSid) continue;
      const id = name.slice(0, -5);
      if (!existing.has(saved.asideSid)) existing.set(saved.asideSid, id);
    } catch { /* one stale bridge file must not break discovery */ }
  }
  const needle = query?.trim().toLocaleLowerCase();
  const entries = rows.map((row) => ({
    sessionId: existing.get(row.id) ?? `${NATIVE_PREFIX}${account}_${validSid(row.id)}`,
    cwd: sessionCwd(row, accountRoot),
    title: typeof row.title === "string" && row.title.trim() ? row.title : `Aside session ${row.id}`,
    updatedAt: isoDate(row.updated_at ?? row.created_at),
  })).filter((entry) => (!cwd || entry.cwd === path.resolve(cwd)) &&
    (!needle || `${entry.title}\n${entry.cwd}\n${entry.sessionId}`.toLocaleLowerCase().includes(needle)));
  return typeof limit === "number" && limit > 0 ? entries.slice(0, limit) : entries;
}

/** Validate a native import before binding; never silently replace it with a new chat. */
export async function getAsideSession(accountRoot, sid) {
  const rows = await querySessions(accountRoot, `id = '${validSid(sid)}' AND COALESCE(incognito, 0) = 0`);
  if (!rows.length) throw new Error("Aside session no longer exists or is unavailable in this account");
  const row = rows[0];
  let model = {};
  try { model = JSON.parse(row.model || "{}"); } catch { /* use composer defaults */ }
  return { sid, cwd: sessionCwd(row, accountRoot), model: model.provider && model.modelId ? `${model.provider}/${model.modelId}` : null, effort: model.thinkingLevel ?? null, permissionMode: row.permission_mode };
}

/** Read native user/assistant/reasoning text without browser tool results or attachments. */
export async function readAsideHistory(accountRoot, sid) {
  const file = transcriptPath(accountRoot, validSid(sid));
  const text = await fs.promises.readFile(file, "utf8").catch((error) => {
    throw new Error(`Cannot read this Aside session's transcript: ${error.code || error.message}`);
  });
  const items = new Map();
  let skipBootstrap = false;
  const reminders = [buildReminder("formal"), buildReminder("casual")];
  for (const [rowIndex, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; /* unfinished final line */ }
    if (!row || typeof row !== "object") continue;
    if (!["user", "assistant"].includes(row.role)) continue;
    const content = typeof row.content === "string" ? [{ type: "text", text: row.content }] : Array.isArray(row.content) ? row.content : [];
    if (row.role === "user") {
      skipBootstrap = content.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.startsWith(`${BOOTSTRAP_MARKER}\n`));
    }
    if (skipBootstrap) continue;
    const rowId = row.responseId ?? row.timestamp ?? rowIndex;
    content.forEach((part, index) => {
      const role = part?.type === "thinking" && row.role === "assistant" ? "reasoning" : part?.type === "text" ? row.role : null;
      let value = role === "reasoning" ? part.thinking : part?.text;
      if (!role || typeof value !== "string" || !value) return;
      if (role === "user") for (const reminder of reminders) {
        if (value.endsWith(reminder)) value = value.slice(0, -reminder.length);
      }
      const id = `aside:${sid}:${row.role}:${rowId}:${index}`;
      items.set(id, { id, role, text: value });
    });
  }
  return [...items.values()];
}
