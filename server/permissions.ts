import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ProviderEvent, ProviderPermissionRequest, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { detectAccountRoot, loadConfig } from "./lib/aside.js";
import { activeSuspension, getNativeClient, suspensionKey, type NativeSuspension } from "./lib/native.js";
import { questionRequest, questionResponse, type AsideQuestionRelay, type BridgeQuestion } from "./questions.js";
export { createAsideQuestionRelay } from "./questions.js";

const PREFIX = "aside-native:";
const QUESTION_PREFIX = "aside-question:";
const POLL_MS = 600;
type JsonValue = NonNullable<ProviderPermissionRequest["input"]>[string];

function permissionRequest(suspension: NativeSuspension): ProviderPermissionRequest {
  const id = PREFIX + createHash("sha256").update(suspensionKey(suspension)).digest("hex");
  if (suspension.kind === "ask-user-question") return questionRequest(id, suspension);
  const confirm = suspension.kind === "action-confirmation";
  const request = suspension.request;
  const scope = request.scope;
  const title = confirm ? request.title || "Confirm action" : scope?.type === "file"
    ? `${scope.mode === "write" ? "Write" : "Read"} ${scope.path}`
    : scope?.type === "browser" ? `${scope.action}${scope.url ? `: ${scope.url}` : ""}`
    : scope?.type === "network" ? `Access ${scope.url}` : `Allow ${scope?.tool || "Aside tool"}`;
  return {
    id, name: confirm ? "Aside final confirmation" : "Aside permission", kind: "tool", title,
    description: confirm ? request.message : "Aside is waiting for permission to perform this operation.",
    detail: { type: "plain_text", label: title, text: confirm
      ? [request.message, request.artifact ? JSON.stringify(request.artifact, null, 2) : ""].filter(Boolean).join("\n\n")
      : JSON.stringify(request.scope, null, 2), icon: "wrench" },
    // Include the complete original scope/draft/artifact for review. A decision
    // is sent back to this suspension, never injected as a new model prompt.
    input: JSON.parse(JSON.stringify({ kind: suspension.kind, ...request })) as Record<string, JsonValue>,
    actions: [
      { id: "allow", label: confirm ? "Confirm" : "Allow once", behavior: "allow", variant: "primary" },
      ...(!confirm && !request.source ? [{ id: "always", label: "Always allow this permission", behavior: "allow" as const }] : []),
      { id: "deny", label: confirm ? "Cancel" : "Reject", behavior: "deny", variant: "secondary" },
    ],
  };
}

/** Relay real Aside approvals and questions through Paseo's standard UI. */
export function withAsidePermissions(provider: ProviderRegistration, questions?: AsideQuestionRelay): ProviderRegistration {
  return {
    ...provider,
    async connect(request) {
      const config = loadConfig();
      const account = Number(path.basename(detectAccountRoot(config.account)));
      const client = getNativeClient(config);
      const connection = await provider.connect(request);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const emit = (event: ProviderEvent) => { if (!closed) for (const listener of listeners) listener(event); };
      let closed = false;
      type Watch = {
        acpId: string; nativeId?: string; timer?: ReturnType<typeof setTimeout>;
        ready: boolean; stopped: boolean; paused: boolean; polling: boolean;
        answering: boolean; error: boolean;
        pending?: { key: string; suspension: NativeSuspension; request: ProviderPermissionRequest };
        ignored: Set<string>;
      };
      const watches = new Map<string, Watch>();
      const forms = new Map<string, { sessionId: string; suspension: NativeSuspension; question: BridgeQuestion }>();
      const unsubscribeQuestions = questions?.observe((question) => {
        const match = [...watches].find(([, watch]) => watch.acpId === question.sessionId && watch.ready && !watch.stopped && !watch.paused);
        if (!match || closed) return false;
        const [sessionId] = match;
        const id = QUESTION_PREFIX + question.id;
        const suspension: NativeSuspension = { id: question.id, kind: "ask-user-question", toolCallId: question.id,
          createdAt: new Date().toISOString(), request: { questions: question.questions } };
        const request = questionRequest(id, suspension);
        forms.set(id, { sessionId, suspension, question });
        void question.done.then(() => {
          if (!forms.delete(id)) return;
          emit({ type: "session.permission_resolved", sessionId, permissionId: id });
        });
        emit({ type: "session.permission", sessionId, request });
        return true;
      });

      function cancelForms(sessionId: string) {
        for (const form of forms.values()) if (form.sessionId === sessionId) form.question.cancel(new Error("Aside question was canceled"));
      }

      function withdraw(sessionId: string, watch: Watch) {
        if (!watch.pending) return;
        emit({ type: "session.permission_resolved", sessionId, permissionId: watch.pending.request.id });
        watch.pending = undefined;
      }

      function notice(sessionId: string, watch: Watch, message?: string) {
        if (!message && !watch.error) return;
        watch.error = !!message;
        emit({ type: "session.notice", sessionId, notice: {
          id: "aside-native-permissions", severity: "error", title: "Aside permission connection",
          ...(message ? { description: message } : { dismissed: true }),
        } });
      }

      function stop(sessionId: string, watch: Watch) {
        cancelForms(sessionId);
        watch.stopped = true;
        clearTimeout(watch.timer);
        withdraw(sessionId, watch);
      }

      function schedule(sessionId: string, watch: Watch, delay = POLL_MS) {
        clearTimeout(watch.timer);
        if (closed || watch.stopped || !watch.ready || watch.paused) return;
        watch.timer = setTimeout(() => { void poll(sessionId, watch); }, delay);
        watch.timer.unref?.();
      }

      async function poll(sessionId: string, watch: Watch) {
        if (closed || watch.stopped || watch.paused || watch.polling || watch.answering) return;
        watch.polling = true;
        try {
          {
            const file = path.join(os.homedir(), ".aside-acp", "sessions", `${watch.acpId}.json`);
            let saved;
            try { saved = JSON.parse(await fs.readFile(file, "utf8")); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
            if (Number(saved.account) !== account) throw new Error("The saved Aside session belongs to another account");
            if (typeof saved.asideSid !== "string" || !/^[a-zA-Z0-9_-]+$/.test(saved.asideSid)) throw new Error("Invalid saved Aside session binding");
            if (watch.nativeId !== saved.asideSid) {
              withdraw(sessionId, watch);
              watch.ignored.clear();
              watch.nativeId = saved.asideSid;
            }
          }
          const native = await client.getSession(account, watch.nativeId!);
          if (closed || watch.stopped || watch.paused || watch.answering) return;
          const suspension = native.status === "suspended" ? activeSuspension(native) : null;
          const key = suspension ? suspensionKey(suspension) : null;
          if (watch.pending && watch.pending.key !== key) withdraw(sessionId, watch);
          if (!suspension || watch.pending || watch.ignored.has(key!)) { notice(sessionId, watch); return; }
          if (!suspension.id) throw new Error("Update Aside: this daemon does not expose suspension IDs needed for safe permission replies.");
          const permission = permissionRequest(suspension);
          watch.pending = { key: key!, suspension, request: permission };
          notice(sessionId, watch);
          emit({ type: "session.permission", sessionId, request: permission });
        } catch (error) {
          if (!closed && !watch.stopped && !watch.paused && !watch.error) notice(sessionId, watch, error instanceof Error ? error.message : String(error));
        } finally {
          watch.polling = false;
          schedule(sessionId, watch);
        }
      }

      function bind(sessionId: string, persistence: { data: JsonValue } | undefined) {
        const data = persistence?.data;
        const acpId = data && typeof data === "object" && !Array.isArray(data) ? data.sessionId : null;
        if (typeof acpId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(acpId)) return;
        const old = watches.get(sessionId);
        if (old?.acpId === acpId) return;
        if (old) stop(sessionId, old);
        watches.set(sessionId, { acpId, ready: false, stopped: false, paused: false, polling: false, answering: false, error: false, ignored: new Set() });
      }

      const unsubscribe = connection.onEvent((event) => {
        if (event.type === "session.opened" || event.type === "session.persistence") bind(event.sessionId, event.persistence);
        const watch = "sessionId" in event ? watches.get(event.sessionId) : undefined;
        if (event.type === "session.ready" && watch) { watch.ready = true; schedule(event.sessionId, watch, 0); }
        if (event.type === "session.closed" && watch) { stop(event.sessionId, watch); watches.delete(event.sessionId); }
        if (event.type === "session.turn" && watch && ["canceled", "failed"].includes(event.state)) {
          cancelForms(event.sessionId);
          if (watch.pending) watch.ignored.add(watch.pending.key);
          withdraw(event.sessionId, watch);
        }
        emit(event);
      });

      return {
        ...connection,
        async send(input) {
          if (closed) throw new Error("Aside permission connection is closed");
          const watch = "sessionId" in input ? watches.get(input.sessionId) : undefined;
          if (input.type === "session.permission" && input.permissionId.startsWith(QUESTION_PREFIX)) {
            const form = forms.get(input.permissionId);
            if (!form || form.sessionId !== input.sessionId || !watch || watch.stopped || watch.paused) throw new Error("This Aside question has expired");
            const answer = input.response.behavior === "allow" ? questionResponse(form.suspension, input.response) : null;
            form.question.answer(answer);
            if (input.response.behavior === "deny" && input.response.interrupt) {
              watch.paused = true;
              await connection.send({ type: "session.interrupt", requestId: randomUUID(), sessionId: input.sessionId });
            }
            return;
          }
          if (input.type === "session.permission" && input.permissionId.startsWith(PREFIX)) {
            const pending = watch?.pending;
            if (!watch || !pending || pending.request.id !== input.permissionId || !watch.nativeId || watch.paused || watch.stopped) {
              throw new Error("This Aside permission request has expired");
            }
            if (watch.answering) throw new Error("This Aside permission is already being answered");
            const isQuestion = pending.suspension.kind === "ask-user-question";
            const answer = isQuestion && input.response.behavior === "allow" ? questionResponse(pending.suspension, input.response) : undefined;
            const actionId = input.response.selectedActionId ?? (input.response.behavior === "allow" ? "allow" : "deny");
            const action = pending.request.actions?.find((item) => item.id === actionId && item.behavior === input.response.behavior);
            if (!isQuestion && !action) throw new Error("Invalid Aside permission action");
            if (!isQuestion && input.response.behavior === "allow" &&
                (input.response.updatedInput != null || input.response.updatedPermissions?.length)) {
              throw new Error("Aside approvals cannot edit the pending operation. Change it in Aside and approve its new request.");
            }
            watch.answering = true;
            try {
              const native = await client.getSession(account, watch.nativeId);
              const current = native.status === "suspended" ? activeSuspension(native) : null;
              if (closed || watch.stopped || watch.paused || watch.pending !== pending) throw new Error("This Aside permission request was canceled");
              if (!current || suspensionKey(current) !== pending.key) {
                withdraw(input.sessionId, watch);
                throw new Error("This Aside permission was already answered or changed. No decision was sent.");
              }
              if (isQuestion && input.response.behavior === "deny") {
                await client.rejectSuspension(account, watch.nativeId, pending.suspension, input.response.message || "The user declined to answer. Do not assume a choice or approval.");
              } else {
                const response = answer ?? (pending.suspension.kind === "approval"
                  ? { verdict: action!.behavior === "allow" ? "allow" : "deny", always: actionId === "always" }
                  : { verdict: action!.behavior === "allow" ? "confirm" : "cancel", ...(input.response.behavior === "deny" && input.response.message ? { instruction: input.response.message } : {}) });
                await client.resolveSuspension(account, watch.nativeId, pending.suspension, response);
              }
              if (watch.pending === pending) withdraw(input.sessionId, watch);
              notice(input.sessionId, watch);
              if (input.response.behavior === "deny" && input.response.interrupt) {
                watch.paused = true;
                await connection.send({ type: "session.interrupt", requestId: randomUUID(), sessionId: input.sessionId });
              }
            } catch (error) {
              if (!closed && !watch.stopped) notice(input.sessionId, watch, error instanceof Error ? error.message : String(error));
              throw error;
            } finally {
              watch.answering = false;
              schedule(input.sessionId, watch, 0);
            }
            return;
          }
          if ((input.type === "session.close" || input.type === "session.interrupt") && watch) {
            cancelForms(input.sessionId);
            if (watch.pending) watch.ignored.add(watch.pending.key);
            watch.paused = true;
            clearTimeout(watch.timer);
            withdraw(input.sessionId, watch);
          }
          if (input.type === "session.prompt" && watch) { watch.paused = false; schedule(input.sessionId, watch, 0); }
          return connection.send(input);
        },
        onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        async close() {
          for (const [sessionId, watch] of watches) stop(sessionId, watch);
          closed = true;
          unsubscribe();
          unsubscribeQuestions?.();
          watches.clear();
          listeners.clear();
          await connection.close();
        },
      };
    },
  };
}
