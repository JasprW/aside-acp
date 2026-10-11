// aside-acp: wrap the Aside browser agent as an ACP (Agent Client Protocol)
// server. Spawned by Paseo (or any ACP client) over stdio; each session maps
// to a persistent aside session; turns stream from Aside's live CLI events.
//
// Design mirrors aside-telegram-bridge (SaiAmartya) where it is proven:
//   - aside exec <prompt> runs each turn
//   - raw CLI events supply text/thinking deltas; completed transcripts
//     recover missing final output
//   - native permission modes and Final confirm settings
//   - the Paseo provider wrapper relays real Aside tool suspensions; legacy
//     [[APPROVAL]] and [[QUESTION]] blocks remain readable on older chats

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import {
  loadConfig,
  detectAccountRoot,
  resolveAsideCli,
  execAsync,
  killTree,
  findNewestSession,
  TranscriptReader,
  stripAnsi,
} from "./lib/aside.js";
import { JsonlTail, AsideTurnStream } from "./lib/stream.js";
import { providerErrorMessage } from "./lib/errors.js";
import { isPermissionMode, buildPermissionState, defaultFinalConfirm, confirmationOption } from "./lib/permissions.js";
import { getNativeClient } from "./lib/native.js";
import { listAsideSessions, parseNativeSessionId, getAsideSession, readAsideHistory } from "./lib/sessions.js";
import {
  buildBootstrapPrompt,
  buildReminder,
  buildPermissionReminder,
  parseApproval,
  parseQuestion,
  approvalGrantedText,
  approvalDeniedText,
  BOOTSTRAP_MARKER,
} from "./lib/persona.js";
import {
  hasFormElicitation,
  questionsToSchema,
  acceptedReplyText,
  declinedReplyText,
} from "./lib/elicitation.js";
import {
  enumerateModels,
  buildConfigOptions,
  buildModelState,
  EFFORT_LEVELS,
} from "./lib/models.js";

const VERSION = "0.4.1";
const APPROVAL_LOOP_LIMIT = 4;
const QUESTION_LOOP_LIMIT = 3;
const PERMISSION_TIMEOUT_MS = 15 * 60 * 1000;
const EVENT_POLL_MS = 40;
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

export class AsideACP {
  constructor(conn, config) {
    this.conn = conn;
    this.config = {
      ...config,
      default_permission: config.default_permission ?? (config.grant_full_access !== false ? "full-access" : "guard"),
    };
    if (!isPermissionMode(this.config.default_permission)) {
      throw new Error(`Invalid Aside default_permission: ${this.config.default_permission}`);
    }
    if (this.config.default_confirmation != null && !["ask-first", "skip-confirmation"].includes(this.config.default_confirmation)) {
      throw new Error(`Invalid Aside default_confirmation: ${this.config.default_confirmation}`);
    }
    this.cli = null;
    this.accountRoot = null;
    this.models = [];
    this.clientElicitation = { form: false, url: false };
    this.sessions = new Map(); // acpSessionId -> SessionState
    this.sessionsRoot = path.join(os.homedir(), ".aside-acp", "sessions");
  }

  async dispose() {
    if (this.disposing) return this.disposing;
    this.disposing = Promise.all([...this.sessions.values()].map(async (st) => {
      const running = st.child || st.ghostExec;
      await this.cancel({ sessionId: st.sessionId });
      for (const queued of st.queue.splice(0)) queued.reject(new Error("ACP connection closed"));
      if (running && st.asideSid && running.exitCode === null) {
        await execAsync(this.cli, ["session", "stop", st.asideSid, ...(this.config.account == null ? [] : ["--account", String(this.config.account)])], {
          timeoutMs: 10000, log,
        }).catch((error) => log(`stop failed: ${error.message}`));
        if (running.exitCode === null) killTree(running);
      }
      this.persistSession(st);
    }));
    return this.disposing;
  }

  async init() {
    this.cli = resolveAsideCli(this.config);
    this.accountRoot = detectAccountRoot(this.config.account);
    this.models = enumerateModels(this.accountRoot, this.config.approved_models);
    if (this.config.account == null) this.config.account = Number(path.basename(this.accountRoot));
    if (!this.config.default_model) {
      let defaultModel;
      try {
        defaultModel = JSON.parse(fs.readFileSync(path.join(this.accountRoot, "settings.json"), "utf8")).defaultModel;
      } catch { /* no account settings yet */ }
      const preferred = defaultModel?.provider && defaultModel?.modelId
        ? `${defaultModel.provider}/${defaultModel.modelId}` : null;
      this.config.default_model = this.models.find((model) => model.id === preferred)?.id || this.models[0]?.id || "";
    }
    log(
      `cli=${this.cli} account=${this.accountRoot} models=${this.models.length}`,
    );
  }

  // --- ACP methods ---------------------------------------------------------

  async initialize(params) {
    // Capability negotiation: remember whether the client can render
    // elicitation forms so [[QUESTION]] can be upgraded from a plain text
    // block to a real elicitation/create (form mode).
    this.clientElicitation = {
      form: hasFormElicitation(params?.clientCapabilities),
      url: !!(params?.clientCapabilities?.elicitation?.url),
    };
    if (this.clientElicitation.form || this.clientElicitation.url) {
      log(
        `client elicitation support: form=${this.clientElicitation.form} url=${this.clientElicitation.url}`,
      );
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {} },
        promptCapabilities: { audio: false, embeddedContext: false, image: false },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: { name: "aside-acp", version: VERSION },
    };
  }

  async authenticate() {
    return {};
  }

  async listSessions(params = {}) {
    if (params.cursor) throw new RequestError(-32602, "Aside returns the complete session list without a cursor");
    const sessions = await listAsideSessions({ accountRoot: this.accountRoot, sessionsRoot: this.sessionsRoot, cwd: params.cwd ?? undefined });
    return { sessions };
  }

  async newSession(params) {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      sessionId,
      asideSid: null,
      model: this.config.default_model,
      effort: this.config.default_effort,
      permissionMode: this.config.default_permission,
      finalConfirm: defaultFinalConfirm(this.config),
      primed: false,
      cwd: params.cwd,
      busy: false,
      queue: [],
      history: [],
      child: null,
      cancelRequested: false,
      pendingPermission: null,
    });
    const st = this.sessions.get(sessionId);
    const configOptions = this.sessionConfigOptions(st);
    return {
      sessionId,
      configOptions,
      modes: buildPermissionState(st.permissionMode),
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
    // Older Paseo agents stored the bridge's placeholder "auto" mode.
    // Keep their current native permission instead of escalating on reconnect.
    if (params.modeId !== "auto" && !isPermissionMode(params.modeId)) {
      throw new RequestError(-32602, `Unknown Aside mode: ${params.modeId}`);
    }
    const change = (st.permissionChange ?? Promise.resolve()).catch(() => {}).then(async () => {
      const current = await this.readSessionPermissions(st);
      if (params.modeId !== "auto") {
        const finalConfirm = params.modeId === "read-only" ? false
          : params.modeId === "guard" && current.permissionMode !== "guard" ? true : current.finalConfirm;
        await this.applySessionPermission(st, params.modeId, finalConfirm);
        st.permissionMode = params.modeId;
        st.finalConfirm = finalConfirm;
        this.persistSession(st);
      } else {
        st.permissionMode = current.permissionMode;
        st.finalConfirm = current.finalConfirm;
      }
      await this.conn.sessionUpdate({ sessionId: st.sessionId, update: {
        sessionUpdate: "current_mode_update", currentModeId: st.permissionMode,
      }});
      await this.emitConfigOption(st, "confirmation");
    });
    st.permissionChange = change;
    await change;
    return {};
  }

  async unstable_setSessionModel(params) {
    const st = this.sessions.get(params.sessionId);
    if (!st) throw new Error(`Session ${params.sessionId} not found`);
    if (params.modelId) {
      this.validateModel(params.modelId);
      log(`setSessionModel: ${st.sessionId} model=${params.modelId}`);
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
    log(`setConfigOption: ${st.sessionId} id=${id} value=${JSON.stringify(value)}`);
    if (id === "model") {
      this.validateModel(value);
      st.model = value;
    } else if (id === "effort" && EFFORT_LEVELS.includes(value)) st.effort = value;
    else if (id === "confirmation" && ["ask-first", "skip-confirmation"].includes(value)) {
      const change = (st.permissionChange ?? Promise.resolve()).catch(() => {}).then(async () => {
        const current = await this.readSessionPermissions(st);
        if (current.permissionMode === "read-only" && value === "ask-first") {
          throw new RequestError(-32602, "Aside disables Final confirm in Read only mode");
        }
        const finalConfirm = value === "ask-first";
        await this.applySessionPermission(st, current.permissionMode, finalConfirm);
        st.permissionMode = current.permissionMode;
        st.finalConfirm = finalConfirm;
        this.persistSession(st);
        await this.conn.sessionUpdate({ sessionId: st.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: st.permissionMode } });
        await this.emitConfigOption(st, id);
      });
      st.permissionChange = change;
      await change;
      return { configOptions: this.sessionConfigOptions(st) };
    }
    else throw new RequestError(-32602, `Unknown Aside configuration: ${id}=${value}`);
    await this.emitConfigOption(st, id);
    this.persistSession(st);
    return { configOptions: this.sessionConfigOptions(st) };
  }

  validateModel(value) {
    if (typeof value !== "string" || !this.models.some((model) => model.id === value)) {
      throw new RequestError(-32602, `Unknown Aside model: ${value}`);
    }
  }

  // --- session persistence (ACP session resume) ----------------------------

  sessionFile(sessionId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error("Invalid ACP session ID");
    return path.join(this.sessionsRoot, `${sessionId}.json`);
  }

  persistSession(st) {
    if (!st.asideSid) return; // nothing durable to restore yet
    let temporary;
    try {
      fs.mkdirSync(this.sessionsRoot, { recursive: true, mode: 0o700 });
      const file = this.sessionFile(st.sessionId);
      temporary = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(
        temporary,
        JSON.stringify({
          sessionId: st.sessionId,
          asideSid: st.asideSid,
          model: st.model,
          effort: st.effort,
          permissionMode: st.permissionMode,
          finalConfirm: st.finalConfirm,
          primed: !!st.asideSid,
          history: st.history || [],
          account: this.config.account,
          cwd: st.cwd,
        }),
        { mode: 0o600 },
      );
      fs.renameSync(temporary, file);
    } catch (e) {
      log(`persist session failed: ${e.message}`);
    } finally {
      if (temporary) try { fs.unlinkSync(temporary); } catch { /* already renamed */ }
    }
  }

  async loadSession(params) {
    const sessionId = params.sessionId;
    this.sessionFile(sessionId);
    let st = this.sessions.get(sessionId);
    if (!st) {
      st = {
        sessionId,
        asideSid: null,
        model: this.config.default_model,
        effort: this.config.default_effort,
        permissionMode: this.config.default_permission,
        finalConfirm: defaultFinalConfirm(this.config),
        primed: false,
        busy: false,
        queue: [],
        history: [],
        child: null,
        ghostExec: null,
        cancelRequested: false,
        lastCancelAt: null,
        pendingPermission: null,
        finishTurn: null,
      };
      try {
        const saved = JSON.parse(fs.readFileSync(this.sessionFile(sessionId), "utf8"));
        if (saved.account != null && saved.account !== this.config.account) {
          throw new Error("Aside account changed; create a new agent for the selected account");
        }
        if (saved.asideSid) {
          st.asideSid = saved.asideSid;
          st.model = saved.model ?? st.model;
          st.effort = saved.effort ?? st.effort;
          if (isPermissionMode(saved.permissionMode)) st.permissionMode = saved.permissionMode;
          if (typeof saved.finalConfirm === "boolean") st.finalConfirm = saved.finalConfirm;
          st.primed = true;
          st.history = Array.isArray(saved.history) ? saved.history : [];
          st.cwd = saved.cwd ?? params.cwd;
          log(`resumed acp session ${sessionId} -> aside session ${st.asideSid}`);
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        /* never bootstrapped on this host — behave like a fresh session */
      }
      const nativeSid = parseNativeSessionId(sessionId, this.accountRoot);
      if (nativeSid) {
        const native = await getAsideSession(this.accountRoot, nativeSid);
        st.asideSid = nativeSid;
        st.primed = true;
        st.cwd = native.cwd;
        if (!st.history.length) {
          st.history = await readAsideHistory(this.accountRoot, nativeSid);
          if (this.models.some((model) => model.id === native.model)) st.model = native.model;
          if (EFFORT_LEVELS.includes(native.effort)) st.effort = native.effort;
        }
        log(`bound imported acp session ${sessionId} -> aside session ${nativeSid}`);
      }
      if (st.asideSid) {
        const native = await getAsideSession(this.accountRoot, st.asideSid);
        if (!isPermissionMode(native.permissionMode)) throw new Error(`Unknown native Aside permission mode: ${native.permissionMode}`);
        st.permissionMode = native.permissionMode;
        st.finalConfirm = native.finalConfirm;
        this.persistSession(st);
      }
      this.sessions.set(sessionId, st);
    }
    for (const item of st.history || []) {
      await this.conn.sessionUpdate({ sessionId, update: {
        sessionUpdate: item.role === "user" ? "user_message_chunk" : item.role === "reasoning" ? "agent_thought_chunk" : "agent_message_chunk",
        messageId: item.id,
        content: { type: "text", text: item.text },
      }});
    }
    const configOptions = this.sessionConfigOptions(st);
    return {
      configOptions,
      modes: buildPermissionState(st.permissionMode),
      ...(this.models.length
        ? { models: buildModelState(this.models, st.model) }
        : {}),
    };
  }

  async emitConfigOption(st, optionId) {
    const opts = this.sessionConfigOptions(st);
    const option = opts.find((o) => o.id === optionId) || opts[0];
    if (!option) return;
    try {
      await this.conn.sessionUpdate({
        sessionId: st.sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: opts,
        },
      });
    } catch {
      /* client gone */
    }
  }

  sessionConfigOptions(st) {
    return [...buildConfigOptions(this.models, st.model, st.effort), confirmationOption(st)];
  }

  async prompt(params) {
    if (this.disposing) throw new Error("Aside connection is closed");
    const st = this.sessions.get(params.sessionId);
    if (!st) throw new Error(`Session ${params.sessionId} not found`);
    const text = extractPromptText(params);
    const full = text + buildReminder(this.config.style);
    if (st.busy) {
      // Serialize like the bridge queue: run after the current turn.
      return await new Promise((resolve, reject) => {
        st.queue.push({ prompt: text, resolve, reject });
      });
    }
    st.history ??= [];
    st.history.push({ id: randomUUID(), role: "user", text });
    st.busy = true;
    st.cancelRequested = false;
    try {
      return await this.runTurn(st, full, params);
    } catch (e) {
      log(`turn threw: ${e?.stack || e}`);
      throw e instanceof RequestError ? e : new RequestError(-32603, e.message || String(e));
    } finally {
      st.busy = false;
      const next = this.disposing ? null : st.queue.shift();
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
    if (st.child && !st.ghostExec) st.ghostExec = st.child;
    if (st.ghostExec && st.ghostExec.exitCode === null) killTree(st.ghostExec);
    st.child = null;
    const pp = st.pendingPermission;
    if (pp) {
      pp.resolve({ outcome: { outcome: "cancelled" } });
      st.pendingPermission = null;
    }
    const pe = st.pendingElicitation;
    if (pe) {
      pe.resolve();
      st.pendingElicitation = null;
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
      if (st.cancelRequested) return { stopReason: "cancelled" };
      if (!ok) throw new Error("Aside session initialization failed; inspect the provider logs");
      st.primed = true;
      this.persistSession(st);
    }
    const sid = st.asideSid;

    let approvals = 0;
    let questionLoops = 0;
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
      if (stopReason === "error") throw new Error(result.error || "Aside turn failed");
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
        throw new Error("Aside returned no output after retries");
      }

      const approval = parseApproval(result.finalText);
      if (approval && st.finalConfirm) {
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
        continue;
      }

      const question = parseQuestion(result.finalText);
      if (question) {
        if (questionLoops >= QUESTION_LOOP_LIMIT) {
          log(`question loop limit reached; leaving question as text`);
          break;
        }
        questionLoops += 1;
        if (this.clientElicitation.form) {
          log(`question via elicitation: ${question.question || question.header}`);
          const outcome = await this.askElicitation(st, question);
          if (outcome === null) {
            // client cancelled the turn / timed out / transport error →
            // leave the question as text (same as the text protocol)
            break;
          }
          inject = outcome.replyText;
          if (outcome.accepted) continue; // continuation turn with the answer
          // declined: continue so aside can acknowledge briefly and stand by
          continue;
        }
        // No elicitation support: surface the question as plain text (the
        // owner replies with a normal follow-up message).
        break;
      }

      // Neither an approval nor a question block: normal end of turn.
      break;
    }
    return { stopReason, usage: null, userMessageId: params.messageId ?? null };
  }

  /**
   * Create the aside session (persona bootstrap) and bind st.asideSid.
   */
  async primeSession(st) {
    const t0 = Date.now();
    const marker = `${BOOTSTRAP_MARKER}:${st.sessionId}`;
    const boot = buildBootstrapPrompt(this.config.style, this.config.owner_name) + `\nConnection: ${marker}\nInitialization only: do not call tools or take any actions. Reply with one brief acknowledgement.`;
    const args = this.buildExecArgs(null, st);
    args.push(boot);
    log(`bootstrap exec (session ${st.sessionId})`);
    const r = await execAsync(this.cli, args, {
      timeoutMs: this.config.exec_timeout_seconds * 1000,
      log,
      onSpawn: (child) => { st.child = child; },
    });
    st.child = null;
    if (r.timedOut || r.code !== 0) {
      log(`bootstrap failed: code=${r.code} ${r.stderr.slice(0, 300)}`);
      return false;
    }
    let sid = findNewestSession(this.accountRoot, {
      newerThanMs: t0,
      mustContain: marker,
      log,
    });
    if (!sid) {
      // Only use the CLI's own session ID; never bind a concurrent user's session.
      sid = /created new session:\s*([a-zA-Z0-9_-]+)/.exec(r.stderr)?.[1] || null;
    }
    if (!sid) {
      log(`bootstrap: no session dir appeared`);
      return false;
    }
    st.asideSid = sid;
    st.appliedModel = st.model;
    st.appliedEffort = st.effort;
    this.persistSession(st); // Retain the binding even if permission setup fails.
    // CLI creation supports Guard and Full access, but not Read only.
    // Apply Read only through the native API before admitting the first task.
    const change = (st.permissionChange ?? Promise.resolve()).catch(() => {}).then(() => this.applySessionPermission(st, st.permissionMode));
    st.permissionChange = change;
    await change;
    log(`bound acp session ${st.sessionId} -> aside session ${sid}`);
    this.persistSession(st);
    return true;
  }

  buildExecArgs(sid, st) {
    const args = ["--host", "local", ...(sid ? ["session", "resume", sid] : ["exec"])];
    if (this.config.account !== null && this.config.account !== undefined) {
      args.push("--account", String(this.config.account));
    }
    if (!sid) {
      if (st.model) args.push("-m", st.model);
      if (st.effort) args.push("--effort", st.effort);
      args.push("--permission", st.permissionMode === "full-access" ? "full-access" : "guard");
    }
    return args;
  }

  async applySessionPermission(st, permissionMode, finalConfirm = st.finalConfirm) {
    if (!st.asideSid) return; // Applied at native session creation.
    const client = getNativeClient(this.config);
    const native = await client.getSession(this.config.account, st.asideSid);
    if (native.permissionMode === permissionMode && (native.runtimeConfig.finalConfirm === true) === finalConfirm) return;
    // Re-sending an unchanged mode would reset Aside's remembered grants.
    await client.updatePermissions(this.config.account, st.asideSid, native.permissionMode === permissionMode ? undefined : permissionMode, finalConfirm);
    const committed = await client.getSession(this.config.account, st.asideSid);
    if (committed.permissionMode !== permissionMode || (committed.runtimeConfig.finalConfirm === true) !== finalConfirm) {
      throw new Error("Aside did not commit the selected permission and confirmation settings");
    }
  }

  async readSessionPermissions(st) {
    if (!st.asideSid) return { permissionMode: st.permissionMode, finalConfirm: st.finalConfirm };
    const native = await getNativeClient(this.config).getSession(this.config.account, st.asideSid);
    if (!isPermissionMode(native.permissionMode)) throw new Error(`Unknown native Aside permission mode: ${native.permissionMode}`);
    return { permissionMode: native.permissionMode,
      finalConfirm: native.permissionMode !== "read-only" && native.runtimeConfig.finalConfirm === true };
  }

  async applySessionModel(st) {
    if (st.appliedModel === st.model && st.appliedEffort === st.effort) return;
    const qualified = st.model || this.models[0]?.id;
    if (!qualified) return;
    const slash = qualified.indexOf("/");
    if (slash < 1) throw new Error(`Expected a provider/model ID, got ${qualified}`);
    const model = {
      provider: qualified.slice(0, slash),
      modelId: qualified.slice(slash + 1),
      thinkingLevel: st.effort,
      fastMode: false,
    };
    const args = ["repl", "--host", "local"];
    if (this.config.account != null) args.push("--account", String(this.config.account));
    args.push(`await aside.sessions.update(${JSON.stringify(st.asideSid)}, { model: ${JSON.stringify(model)} }); console.log("ASIDE_ACP_MODEL_UPDATED");`);
    const result = await execAsync(this.cli, args, { timeoutMs: 30000, log });
    if (result.code !== 0 || !result.stdout.includes("ASIDE_ACP_MODEL_UPDATED")) {
      throw new Error(`Aside model update failed: ${result.stderr || result.stdout}`);
    }
    st.appliedModel = st.model;
    st.appliedEffort = st.effort;
  }

  /**
   * Parse leading [model:...] / [effort:...] / [models] directives from a
   * prompt. These remain available to text-only ACP clients; the Paseo
   * provider also exposes native model and thinking controls.
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
        this.validateModel(val.trim());
        st.model = val.trim();
        changed = true;
        log(`directive: ${st.sessionId} model=${st.model}`);
      } else if (key === "effort" && val) {
        const v = val.trim();
        if (EFFORT_LEVELS.includes(v)) {
          st.effort = v;
          changed = true;
          log(`directive: ${st.sessionId} effort=${st.effort}`);
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
   * Run one Aside turn and forward live text/thinking events as chunks.
   * Returns { stopReason, finalText, error }.
   */
  async runAsideTurn(st, sid, promptText) {
    st.messageId = randomUUID();
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
    // Let the CLI finish aborting the native task before admitting another turn.
    if (st.ghostExec) {
      const ghost = st.ghostExec;
      await new Promise((resolve, reject) => {
        if (ghost.exitCode !== null || ghost.signalCode !== null) return resolve();
        const finish = () => { clearTimeout(timer); ghost.removeListener("close", finish); ghost.removeListener("error", finish); resolve(); };
        const timer = setTimeout(() => {
          ghost.removeListener("close", finish);
          ghost.removeListener("error", finish);
          reject(new Error("Aside CLI did not exit after cancellation"));
        }, GHOST_WAIT_TIMEOUT_MS);
        ghost.once("close", finish);
        ghost.once("error", finish);
      });
      st.ghostExec = null;
    }
    // Wait for the user's pending permission selection before starting work.
    await st.permissionChange?.catch(() => {});
    await this.applySessionModel(st);
    // Read live choices, including changes made in Aside, before each task.
    // Explicit setters already commit their selections atomically above.
    const native = await this.readSessionPermissions(st);
    const finalConfirm = native.finalConfirm;
    if (st.permissionMode !== native.permissionMode || st.finalConfirm !== finalConfirm) {
      st.permissionMode = native.permissionMode;
      st.finalConfirm = finalConfirm;
      this.persistSession(st);
      await this.conn.sessionUpdate({ sessionId: st.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: st.permissionMode } });
      await this.emitConfigOption(st, "confirmation");
    }
    if (st.cancelRequested || this.disposing) return { stopReason: "cancelled", finalText: "" };
    const reader = new TranscriptReader(this.accountRoot, sid, log);
    reader.open();
    // The CLI's raw-event option is global, including for session resume.
    // Private per-turn files contain model output and are removed after CLI exit.
    const eventDir = fs.mkdtempSync(path.join(os.tmpdir(), "aside-acp-events-"));
    const eventFile = path.join(eventDir, "events.jsonl");
    fs.writeFileSync(eventFile, "", { mode: 0o600 });
    const events = new JsonlTail(eventFile, log);
    const pending = new Set();
    let historyDirty = false;
    const stream = new AsideTurnStream((text, role, messageId) => {
      historyDirty = true;
      const sent = this.emitChunk(st.sessionId, text, { role, messageId, persist: false });
      pending.add(sent);
      void sent.finally(() => pending.delete(sent));
    }, log);
    const args = this.buildExecArgs(sid, st);
    args.unshift("--log-dump", eventFile);
    promptText += buildPermissionReminder(st.permissionMode, st.finalConfirm);
    args.push(promptText);
    log(`turn exec (${st.sessionId}) ${stripAnsi(promptText).slice(0, 120)}...`);

    const child = spawn(this.cli, args, { stdio: ["ignore", "ignore", "pipe"] });
    st.child = child;
    let stderr = "";
    child.stderr?.on("data", (d) => { stderr = (stderr + d).slice(-8192); });
    const cleanupEvents = () => {
      try { fs.rmSync(eventDir, { recursive: true, force: true }); }
      catch (error) { log(`event cleanup failed: ${error.message}`); }
    };
    let turnFinished = false;
    // Cancellation can resolve the turn before the native CLI has exited.
    child.once("close", () => {
      if (turnFinished) cleanupEvents();
    });

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

    const drain = () => {
      for (const event of events.read()) stream.accept(event);
    };
    const poll = setInterval(drain, EVENT_POLL_MS);
    const save = setInterval(() => {
      if (!historyDirty) return;
      historyDirty = false;
      this.persistSession(st);
    }, 250);

    let res;
    try {
      res = await finished;
      clearInterval(poll);
      clearInterval(save);
      // CLI flushes all raw events before normal exit. Read before deleting.
      drain();
      if (!st.cancelRequested) {
        const rd = reader.read();
        for (const message of rd.messages) stream.complete(message);
        if (rd.errors.length) stream.error = rd.errors[rd.errors.length - 1];
      }
      // Finish delivery before ACP prompt returns, bounded on disconnect.
      await Promise.allSettled([...pending]);
    } finally {
      turnFinished = true;
      st.finishTurn = null;
      clearInterval(poll);
      clearInterval(save);
      clearTimeout(timer);
      this.persistSession(st);
      if (res?.err || child.exitCode !== null || child.signalCode !== null) cleanupEvents();
    }
    const providerError = stream.error;
    const totalParts = stream.textChunks;
    log(`turn finished (${st.sessionId}) res=${JSON.stringify(res)} events=${stream.events}`);

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
      return { stopReason: "error", finalText: "", error: `Aside turn timed out after ${Math.round(timeoutMs / 1000)}s` };
    }
    if (providerError) {
      log(`provider error: ${providerError}`);
      return { stopReason: "error", finalText: "", error: providerErrorMessage(providerError) };
    }
    if (res.err || res.code !== 0) {
      log(`aside exec failed: code=${res.code} ${stripAnsi(stderr).slice(0, 300)}`);
      return { stopReason: "error", finalText: "", error: `Aside CLI failed: ${stripAnsi(stderr).trim().slice(0, 1000) || res.err?.message || `exit ${res.code}`}` };
    }
    const finalText = stream.finalText;
    // log stderr even on success — aside exec can exit 0 while silently
    // refusing the turn (steer-after-cancel), and the reason lives in stderr
    log(`turn exit=${res.code} parts=${totalParts} stderr=${stripAnsi(stderr).slice(0, 300)}`);
    return { stopReason: "end_turn", finalText, empty: totalParts === 0 };
  }

  async emitChunk(acpSessionId, text, { role = "assistant", messageId, persist = true } = {}) {
    const st = this.sessions.get(acpSessionId);
    messageId ??= st?.messageId ?? randomUUID();
    if (st) {
      st.history ??= [];
      const existing = st.history.findLast((item) => item.id === messageId);
      if (existing) existing.text += text;
      else st.history.push({ id: messageId, role, text });
      if (persist) this.persistSession(st);
    }
    // A disconnected ACP writer may never resolve; do not wedge turn cleanup.
    let timer;
    try {
      await Promise.race([
        this.conn.sessionUpdate({
          sessionId: acpSessionId,
          update: {
            sessionUpdate: role === "reasoning" ? "agent_thought_chunk" : "agent_message_chunk",
            messageId,
            content: { type: "text", text },
          },
        }),
        new Promise((resolve) => { timer = setTimeout(resolve, 2000); }),
      ]);
    } catch {
      /* client gone — keep running, history persists */
    } finally {
      clearTimeout(timer);
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

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), PERMISSION_TIMEOUT_MS);
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

    try {
      return await Promise.race([req, cancelPromise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Upgrade a [[QUESTION]] block to a real ACP elicitation (form mode) when
   * the client advertises elicitation support. Returns:
   *   { accepted: true, replyText }  → user answered, inject and continue
   *   { accepted: false, replyText } → user declined, inject and continue
   *   null                           → cancelled / timed out / transport error
   */
  async askElicitation(st, question) {
    const requestedSchema = questionsToSchema([question]);
    const message = question.question || question.header || "The agent needs your input.";
    let resolveCancel;
    const cancelPromise = new Promise((resolve) => {
      resolveCancel = resolve;
    });
    st.pendingElicitation = {
      resolve: () => resolveCancel(null),
    };

    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), PERMISSION_TIMEOUT_MS);
    });

    const req = this.conn
      .unstable_createElicitation({
        sessionId: st.sessionId,
        mode: "form",
        message,
        requestedSchema,
      })
      .then((r) => {
        st.pendingElicitation = null;
        return r;
      })
      .catch((e) => {
        st.pendingElicitation = null;
        log(`elicitation/create failed: ${e?.message || e}`);
        return null;
      });

    let res;
    try {
      res = await Promise.race([req, cancelPromise, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (!res) return null;
    if (res.action === "accept") {
      return { accepted: true, replyText: acceptedReplyText(res.content, [question]) };
    }
    if (res.action === "decline") {
      return { accepted: false, replyText: declinedReplyText() };
    }
    return null; // cancel / unknown action
  }
}

function extractPromptText(params) {
  const blocks = Array.isArray(params.prompt) ? params.prompt : [];
  return blocks
    .map((b) => (b && b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Create the same ACP agent for stdio and Paseo's in-process connector. */
export async function connectAsideAgent(stream) {
  const agent = new AsideACP(null, loadConfig());
  await agent.init();
  const connection = new AgentSideConnection((conn) => {
    agent.conn = conn;
    return agent;
  }, stream);
  const dispose = () => agent.dispose();
  void connection.closed.then(dispose).catch((error) => log(`cleanup failed: ${error.message}`));
  log(`aside-acp v${VERSION} ready (protocol v${PROTOCOL_VERSION})`);
  return { connection, dispose };
}
