#!/usr/bin/env node
// aside-acp: wrap the Aside browser agent as an ACP (Agent Client Protocol)
// server. Spawned by Paseo (or any ACP client) over stdio; each session maps
// to a persistent aside session; turns stream from the aside transcript.
//
// Design mirrors aside-telegram-bridge (SaiAmartya) where it is proven:
//   - aside exec <prompt> runs each turn
//   - messages.jsonl is polled for new assistant text (streamed as
//     agent_message_chunk)
//   - sessions run full-access, with a soft [[APPROVAL]]/[[QUESTION]]
//     protocol instead of aside's desktop-only confirmation tools
//   - [[APPROVAL]] blocks are translated to ACP requestPermission so Paseo
//     renders its native Approve/Deny UI mid-turn

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import {
  loadConfig,
  detectAccountRoot,
  resolveAsideCli,
  execAsync,
  killTree,
  grantFullAccess,
  findNewestSession,
  TranscriptReader,
  stripAnsi,
} from "./lib/aside.js";
import {
  buildBootstrapPrompt,
  buildReminder,
  parseApproval,
  parseQuestion,
  approvalGrantedText,
  approvalDeniedText,
  BOOTSTRAP_MARKER,
} from "./lib/persona.js";
import {
  enumerateModels,
  buildConfigOptions,
  buildModelState,
  EFFORT_LEVELS,
} from "./lib/models.js";

const VERSION = "0.1.0";
const APPROVAL_LOOP_LIMIT = 4;
const PERMISSION_TIMEOUT_MS = 15 * 60 * 1000;
const TRANSCRIPT_POLL_MS = 300;
const GHOST_WAIT_TIMEOUT_MS = 180000;
const EMPTY_TURN_RETRY_MS = 3000;
const EMPTY_TURN_RETRIES = 2;

const LOG_FILE = process.env.ASIDE_ACP_LOG_FILE || "";
function log(...args) {
  const line = `[aside-acp ${new Date().toISOString()}] ${args.join(" ")}`;
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, line + "\n");
    } catch {
      /* ignore */
    }
  }
  process.stderr.write(line + "\n");
}

class AsideACP {
  constructor(conn, config) {
    this.conn = conn;
    this.config = config;
    this.cli = null;
    this.accountRoot = null;
    this.models = [];
    this.sessions = new Map(); // acpSessionId -> SessionState
    this.sessionsRoot = path.join(os.homedir(), ".aside-acp", "sessions");
  }

  async init() {
    this.cli = resolveAsideCli(this.config);
    this.accountRoot = detectAccountRoot(this.config.account);
    this.models = enumerateModels(this.accountRoot, this.config.approved_models);
    log(
      `cli=${this.cli} account=${this.accountRoot} models=${this.models.length}`,
    );
  }

  // --- ACP methods ---------------------------------------------------------

  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {},
        promptCapabilities: { audio: false, embeddedContext: false, image: false },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: { name: "aside-acp", version: VERSION },
    };
  }

  async authenticate() {
    return {};
  }

  async newSession(params) {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      sessionId,
      asideSid: null,
      model: this.config.default_model,
      effort: this.config.default_effort,
      primed: false,
      busy: false,
      queue: [],
      child: null,
      cancelRequested: false,
      pendingPermission: null,
    });
    const st = this.sessions.get(sessionId);
    const configOptions = buildConfigOptions(
      this.models,
      this.config.default_model,
      this.config.default_effort,
    );
    return {
      sessionId,
      configOptions,
      modes: {
        currentModeId: "auto",
        availableModes: [{ id: "auto", name: "Auto" }],
      },
      ...(this.models.length
        ? {
            models: buildModelState(
              this.models,
              this.config.default_model,
            ),
          }
        : {}),
    };
  }

  async setSessionMode(params) {
    const st = this.sessions.get(params.sessionId);
    if (!st) throw new Error(`Session ${params.sessionId} not found`);
    st.mode = params.modeId;
    return {};
  }

  async unstable_setSessionModel(params) {
    const st = this.sessions.get(params.sessionId);
    if (!st) throw new Error(`Session ${params.sessionId} not found`);
    if (params.modelId) {
      log(`setSessionModel: ${st.acpId} model=${params.modelId}`);
      st.model = params.modelId;
    }
    await this.emitConfigOption(st, "model");
    return {};
  }

  async setSessionConfigOption(params) {
    const st = this.sessions.get(params.sessionId);
    if (!st) throw new Error(`Session ${params.sessionId} not found`);
    const id = params.configId;
    const value = typeof params.value === "string" ? params.value : params.value?.value;
    log(`setConfigOption: ${st.acpId} id=${id} value=${JSON.stringify(value)}`);
    if (id === "model" && value) st.model = value;
    if (id === "effort" && value) {
      if (EFFORT_LEVELS.includes(value)) st.effort = value;
    }
    await this.emitConfigOption(st, id);
    this.persistSession(st);
    return {};
  }

  // --- session persistence (ACP session resume) ----------------------------

  sessionFile(sessionId) {
    return path.join(this.sessionsRoot, `${sessionId}.json`);
  }

  persistSession(st) {
    if (!st.asideSid) return; // nothing durable to restore yet
    try {
      fs.mkdirSync(this.sessionsRoot, { recursive: true });
      fs.writeFileSync(
        this.sessionFile(st.sessionId),
        JSON.stringify({
          sessionId: st.sessionId,
          asideSid: st.asideSid,
          model: st.model,
          effort: st.effort,
          primed: !!st.asideSid,
        }),
      );
    } catch (e) {
      log(`persist session failed: ${e.message}`);
    }
  }

  async loadSession(params) {
    const sessionId = params.sessionId;
    let st = this.sessions.get(sessionId);
    if (!st) {
      st = {
        sessionId,
        asideSid: null,
        model: this.config.default_model,
        effort: this.config.default_effort,
        primed: false,
        busy: false,
        queue: [],
        child: null,
        ghostExec: null,
        cancelRequested: false,
        lastCancelAt: null,
        pendingPermission: null,
        finishTurn: null,
      };
      try {
        const saved = JSON.parse(fs.readFileSync(this.sessionFile(sessionId), "utf8"));
        if (saved.asideSid) {
          st.asideSid = saved.asideSid;
          st.model = saved.model ?? st.model;
          st.effort = saved.effort ?? st.effort;
          st.primed = true;
          log(`resumed acp session ${sessionId} -> aside session ${st.asideSid}`);
        }
      } catch {
        /* never bootstrapped on this host — behave like a fresh session */
      }
      this.sessions.set(sessionId, st);
    }
    const configOptions = buildConfigOptions(this.models, st.model, st.effort);
    return {
      configOptions,
      modes: {
        currentModeId: "auto",
        availableModes: [{ id: "auto", name: "Auto" }],
      },
      ...(this.models.length
        ? { models: buildModelState(this.models, st.model) }
        : {}),
    };
  }

  async emitConfigOption(st, optionId) {
    const opts = buildConfigOptions(this.models, st.model, st.effort);
    const option = opts.find((o) => o.id === optionId) || opts[0];
    if (!option) return;
    try {
      await this.conn.sessionUpdate({
        sessionId: st.sessionId,
        update: {
          sessionUpdate: "config_option_update",
          option,
        },
      });
    } catch {
      /* client gone */
    }
  }

  async prompt(params) {
    const st = this.sessions.get(params.sessionId);
    if (!st) throw new Error(`Session ${params.sessionId} not found`);
    const text = extractPromptText(params);
    const full = text + buildReminder(this.config.style);
    if (st.busy) {
      // Serialize like the bridge queue: run after the current turn.
      return await new Promise((resolve, reject) => {
        st.queue.push({ prompt: full, resolve, reject });
      });
    }
    st.busy = true;
    st.cancelRequested = false;
    try {
      return await this.runTurn(st, full, params);
    } catch (e) {
      log(`turn threw: ${e?.stack || e}`);
      return { stopReason: "error", usage: null, userMessageId: params.messageId ?? null };
    } finally {
      st.busy = false;
      const next = st.queue.shift();
      if (next) {
        setImmediate(() => {
          this.prompt({ sessionId: st.sessionId, prompt: [{ type: "text", text: next.prompt }] })
            .then(next.resolve)
            .catch(next.reject);
        });
      }
    }
  }

  async cancel(params) {
    const st = this.sessions.get(params.sessionId);
    if (!st) return;
    st.cancelRequested = true;
    st.lastCancelAt = Date.now();
    // Resolve the in-flight turn IMMEDIATELY so Paseo's steer
    // (replaceAgentRun: cancel then startTurn) can proceed.
    if (st.finishTurn) st.finishTurn({ code: -1, cancelled: true });
    // DELIBERATELY do NOT kill the aside exec process: SIGKILL only kills
    // the CLI wrapper while the aside daemon keeps running the turn, which
    // locks the session and makes the next exec on it hang until the ghost
    // turn finishes (verified: 35s stall, prompt swallowed). Instead the
    // old turn runs to completion invisibly and the next turn WAITS for the
    // process to exit before starting (see runAsideTurn). Keep a reference
    // to the still-running child so the next turn can wait on it.
    if (st.child && !st.ghostExec) st.ghostExec = st.child;
    st.child = null;
    const pp = st.pendingPermission;
    if (pp) {
      pp.resolve({ outcome: { outcome: "cancelled" } });
      st.pendingPermission = null;
    }
    log(`cancel requested for session ${st.sessionId} (ghost=${!!st.ghostExec})`);
  }

  // --- turn machinery --------------------------------------------------------

  runTurn(st, promptText, params) {
    return this.runTurnInner(st, promptText, params);
  }

  async runTurnInner(st, promptText, params) {
    if (!st.asideSid) {
      const ok = await this.primeSession(st);
      if (!ok) return { stopReason: "error", usage: null, userMessageId: params.messageId ?? null };
      st.primed = true;
      this.persistSession(st);
    }
    const sid = st.asideSid;

    let approvals = 0;
    let stopReason = "end_turn";
    let inject = promptText;
    let emptyRetries = 0;
    for (;;) {
      if (st.cancelRequested) {
        stopReason = "cancelled";
        break;
      }
      const result = await this.runAsideTurn(st, sid, inject);
      stopReason = result.stopReason;
      if (stopReason !== "end_turn") break;

      // aside exec can exit 0 with NO transcript output when the daemon is
      // still cleaning up an interrupted turn (Paseo steer). Retry instead
      // of reporting an empty success.
      if (result.empty) {
        if (emptyRetries < EMPTY_TURN_RETRIES) {
          emptyRetries += 1;
          log(`empty turn, retrying in ${EMPTY_TURN_RETRY_MS}ms (${emptyRetries}/${EMPTY_TURN_RETRIES})`);
          await new Promise((r) => setTimeout(r, EMPTY_TURN_RETRY_MS));
          continue;
        }
        this.emitChunk(st.sessionId, "\n\n(aside returned no output after retries)").catch(() => {});
        break;
      }

      const approval = parseApproval(result.finalText);
      if (!approval) break;
      if (approvals >= APPROVAL_LOOP_LIMIT) {
        log(`approval loop limit reached; leaving approval as text`);
        break;
      }
      approvals += 1;
      log(`approval request: ${approval.action}`);
      const outcome = await this.requestApproval(st, approval);
      // requestPermission resolves { outcome: { outcome, optionId } }
      const decision = outcome?.outcome;
      if (!decision || decision.outcome !== "selected") {
        if (decision?.outcome === "cancelled") stopReason = "cancelled";
        break; // user ignored/denied at UI level → leave as text
      }
      inject =
        decision.optionId === "allow"
          ? approvalGrantedText(approval.action)
          : approvalDeniedText(approval.action);
      // loop → run the continuation turn
    }
    return { stopReason, usage: null, userMessageId: params.messageId ?? null };
  }

  /**
   * Create the aside session (persona bootstrap) and bind st.asideSid.
   */
  async primeSession(st) {
    const t0 = Date.now();
    const boot = buildBootstrapPrompt(this.config.style, this.config.owner_name);
    const args = this.buildExecArgs(null, st);
    args.push(boot);
    log(`bootstrap exec (session ${st.sessionId})`);
    const r = await execAsync(this.cli, args, {
      timeoutMs: this.config.exec_timeout_seconds * 1000,
      log,
    });
    if (r.timedOut || r.code !== 0) {
      log(`bootstrap failed: code=${r.code} ${r.stderr.slice(0, 300)}`);
      return false;
    }
    let sid = findNewestSession(this.accountRoot, {
      newerThanMs: t0,
      mustContain: BOOTSTRAP_MARKER,
      log,
    });
    if (!sid) {
      // marker scan failed but a session was created — accept newest fallback
      sid = findNewestSession(this.accountRoot, { newerThanMs: t0, log });
    }
    if (!sid) {
      log(`bootstrap: no session dir appeared`);
      return false;
    }
    st.asideSid = sid;
    if (this.config.grant_full_access) {
      grantFullAccess(this.cli, sid, log, this.config.account);
    }
    log(`bound acp session ${st.sessionId} -> aside session ${sid}`);
    this.persistSession(st);
    return true;
  }

  buildExecArgs(sid, st) {
    const args = ["exec"];
    if (this.config.account !== null && this.config.account !== undefined) {
      args.push("--account", String(this.config.account));
    }
    if (st.model) args.push("-m", st.model);
    if (st.effort) args.push("--effort", st.effort);
    if (sid) args.push("--session", sid);
    return args;
  }

  /**
   * Parse leading [model:...] / [effort:...] / [models] directives from a
   * prompt. Paseo's CLI does NOT forward --model to ACP providers (verified
   * on 0.3.1 and 0.4.0), so this is the bridge's own model switch — same
   * spirit as aside-telegram-bridge's /model + /effort chat commands but
   * adapted to Paseo's prompt-only interface.
   *
   * Returns { prompt, reply, changed }:
   *   - prompt:  input minus consumed directives
   *   - reply:   non-null when the turn should NOT hit aside (e.g. [models])
   *   - changed: whether st.model / st.effort were modified
   */
  parsePromptDirectives(st, promptText) {
    let rest = promptText.trimStart();
    let reply = null;
    let changed = false;
    const re = /^\[(model|effort|models)(?::([^\]]+))?\]/;
    for (;;) {
      const m = re.exec(rest);
      if (!m) break;
      const [full, key, val] = m;
      if (key === "model" && val) {
        st.model = val.trim();
        changed = true;
        log(`directive: ${st.acpId} model=${st.model}`);
      } else if (key === "effort" && val) {
        const v = val.trim();
        if (EFFORT_LEVELS.includes(v)) {
          st.effort = v;
          changed = true;
          log(`directive: ${st.acpId} effort=${st.effort}`);
        }
      } else if (key === "models") {
        reply = this.buildModelsList(st);
      }
      rest = rest.slice(full.length).trimStart();
    }
    return { prompt: rest, reply, changed };
  }

  buildModelsList(st) {
    const lines = [`Available aside models (${this.models.length}):`, ""];
    for (const m of this.models) {
      lines.push(`- \`${m.id}\`` +
        (m.label && m.label !== m.id ? ` — ${m.label}` : ""));
    }
    lines.push("", "Usage: [model:<qualified-id>] [effort:off|minimal|low|medium|high|xhigh|max] then your prompt.", "");
    lines.push("Current: " + (st.model || "(default)"));
    return lines.join("\n");
  }

  /**
   * Run one aside exec turn and stream transcript text as chunks.
   * Returns { stopReason, finalText, error }.
   */
  async runAsideTurn(st, sid, promptText) {
    // Bridge-level directives: [model:...] [effort:...] [models]
    const { prompt: cleanPrompt, reply, changed } = this.parsePromptDirectives(
      st,
      promptText
    );
    // Pure directive prompt (e.g. just "[model:xxx]"): switch state, confirm,
    // do NOT hit aside. Same for [models]. Must emit the text ourselves —
    // there's no aside transcript streaming it.
    if (reply !== null || (changed && cleanPrompt === "")) {
      const text =
        reply ??
        `Model switched to \`${st.model}\`${st.effort ? `, effort \`${st.effort}\`` : ""}. Next prompt will run on it.`;
      this.persistSession(st);
      await this.emitChunk(st.sessionId, text).catch(() => {});
      return { stopReason: "end_turn", finalText: text, error: null };
    }
    promptText = cleanPrompt;
    this.persistSession(st);
    // If a cancelled turn's aside exec is still running (we deliberately
    // don't kill it — killing corrupts the aside daemon's session state),
    // WAIT for it to exit before starting a new exec on the same session.
    // Starting a new exec while the old one runs makes the daemon queue the
    // new prompt invisibly and swallow it. Bounded so a wedged ghost can't
    // block forever.
    if (st.ghostExec) {
      const ghost = st.ghostExec;
      log(`waiting for ghost exec to exit (${st.sessionId})`);
      await Promise.race([
        new Promise((r) => {
          ghost.once("exit", r);
          ghost.once("error", r);
        }),
        new Promise((r) => setTimeout(r, GHOST_WAIT_TIMEOUT_MS)),
      ]);
      st.ghostExec = null;
      log(`ghost exec done (${st.sessionId})`);
    }
    const reader = new TranscriptReader(this.accountRoot, sid, log);
    reader.open();
    const args = this.buildExecArgs(sid, st);
    args.push(promptText);
    log(`turn exec (${st.sessionId}) ${stripAnsi(promptText).slice(0, 120)}...`);

    const child = spawn(this.cli, args, { stdio: ["ignore", "pipe", "pipe"] });
    st.child = child;
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));

    const finished = new Promise((resolve) => {
      st.finishTurn = (res) => resolve(res);
      child.on("error", (e) => resolve({ code: -1, timedOut: false, err: e }));
      child.on("close", (code) => resolve({ code, timedOut: false }));
    });
    const timeoutMs = this.config.exec_timeout_seconds * 1000;
    const timer = setTimeout(() => {
      log(`turn timeout after ${timeoutMs}ms`);
      killTree(child);
      st.timeoutHit = true;
    }, timeoutMs);

    let providerError = "";
    let totalParts = 0;
    const allParts = [];
    const poll = setInterval(() => {
      const rd = reader.read();
      totalParts += rd.parts.length;
      for (const p of rd.parts) {
        allParts.push(p.text);
        this.emitChunk(st.sessionId, p.text).catch(() => {});
      }
      if (rd.errors.length) providerError = rd.errors[rd.errors.length - 1];
    }, TRANSCRIPT_POLL_MS);

    const res = await finished;
    st.finishTurn = null;
    clearInterval(poll);
    clearTimeout(timer);
    log(`turn finished (${st.sessionId}) res=${JSON.stringify(res)}`);

    // final drain — fire-and-forget: awaiting sessionUpdate here can hang
    // forever when the client connection is gone (Paseo closes the socket
    // when it considers the agent idle), which wedges the whole turn.
    const rd = reader.read();
    totalParts += rd.parts.length;
    for (const p of rd.parts) {
      allParts.push(p.text);
      this.emitChunk(st.sessionId, p.text).catch(() => {});
    }
    if (rd.errors.length) providerError = rd.errors[rd.errors.length - 1];

    st.child = null;
    if (st.cancelRequested) {
      // keep the still-running child so the next turn can wait for it
      // (the aside daemon finishes the turn in the background)
      if (child && !st.ghostExec) st.ghostExec = child;
      log(`turn cancelled (${st.sessionId})`);
      return { stopReason: "cancelled", finalText: "" };
    }
    if (st.timeoutHit) {
      st.timeoutHit = false;
      await this.emitChunk(
        st.sessionId,
        `\n\n(turn timed out after ${Math.round(timeoutMs / 1000)}s)`,
      );
      return { stopReason: "error", finalText: "" };
    }
    if (providerError) {
      log(`provider error: ${providerError}`);
      await this.emitChunk(st.sessionId, `\n\n(the model provider refused that turn: ${providerError})`);
      return { stopReason: "error", finalText: "" };
    }
    if (res.err || res.code !== 0) {
      log(`aside exec failed: code=${res.code} ${stripAnsi(stderr).slice(0, 300)}`);
      await this.emitChunk(st.sessionId, `\n\n(aside exec failed: ${stripAnsi(stderr).slice(0, 300) || "unknown error"})`);
      return { stopReason: "error", finalText: "" };
    }
    const finalText = allParts.join("\n");
    // log stderr even on success — aside exec can exit 0 while silently
    // refusing the turn (steer-after-cancel), and the reason lives in stderr
    log(`turn exit=${res.code} parts=${totalParts} stderr=${stripAnsi(stderr).slice(0, 300)}`);
    return { stopReason: "end_turn", finalText, empty: totalParts === 0 };
  }

  async emitChunk(acpSessionId, text) {
    try {
      await this.conn.sessionUpdate({
        sessionId: acpSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      });
    } catch {
      /* client gone — keep running, transcripts persist */
    }
  }

  /**
   * Translate a [[APPROVAL]] block into an ACP requestPermission.
   * Returns the client's outcome ({outcome, optionId}) or null on failure.
   */
  async requestApproval(st, approval) {
    const toolCallId = randomUUID();
    let resolveCancel;
    const cancelPromise = new Promise((resolve) => {
      resolveCancel = resolve;
    });
    st.pendingPermission = { resolve: () => resolveCancel({ outcome: { outcome: "cancelled" } }) };

    const timeout = new Promise((resolve) => {
      setTimeout(() => resolve(null), PERMISSION_TIMEOUT_MS);
    });

    const req = this.conn
      .requestPermission({
        sessionId: st.sessionId,
        toolCall: {
          toolCallId,
          title: approval.action.slice(0, 200),
          kind: "edit",
          status: "pending",
          rawInput: { details: approval.details, action: approval.action },
        },
        options: [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
      })
      .then((r) => {
        st.pendingPermission = null;
        return r;
      })
      .catch(() => {
        st.pendingPermission = null;
        return null;
      });

    return await Promise.race([req, cancelPromise, timeout]);
  }
}

function extractPromptText(params) {
  const blocks = Array.isArray(params.prompt) ? params.prompt : [];
  return blocks
    .map((b) => (b && b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

async function main() {
  const config = loadConfig();
  const agent = new AsideACP(null, config);
  await agent.init();
  // NOTE: ndJsonStream(output, input) — writable side first, readable side
  // second (the SDK's own examples name them misleadingly).
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout),
    Readable.toWeb(process.stdin),
  );
  const conn = new AgentSideConnection((c) => {
    agent.conn = c;
    return agent;
  }, stream);
  log(`aside-acp v${VERSION} ready (protocol v${PROTOCOL_VERSION})`);
  await new Promise(() => {}); // run until stdin closes
}

main().catch((e) => {
  log(`fatal: ${e.stack || e}`);
  process.exit(1);
});
