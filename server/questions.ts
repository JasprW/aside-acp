import type { ProviderPermissionRequest, ProviderPermissionResponse } from "@getpaseo/plugin/server/provider";
import type { NativeSuspension } from "./lib/native.js";
import { randomUUID } from "node:crypto";

export type QuestionAnswer = { answers: Array<{ header: string; answer: string }> };
export interface BridgeQuestion {
  id: string; sessionId: string; questions: unknown[]; done: Promise<void>;
  answer(value: QuestionAnswer | null): void;
  cancel(error: Error): void;
}
export interface AsideQuestionRelay {
  request(sessionId: string, questions: unknown[], signal: AbortSignal): Promise<QuestionAnswer | null>;
  observe(listener: (question: BridgeQuestion) => boolean): () => void;
}

/** A connection-local human-input channel for headless CLI sessions. */
export function createAsideQuestionRelay(): AsideQuestionRelay {
  const listeners = new Set<(question: BridgeQuestion) => boolean>();
  return {
    observe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    request(sessionId, questions, signal) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let markDone!: () => void;
        const done = new Promise<void>((finish) => { markDone = finish; });
        const finish = (value: QuestionAnswer | null, error?: Error) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          markDone();
          if (error) reject(error); else resolve(value);
        };
        const abort = () => finish(null, new Error("Aside question was canceled"));
        const question: BridgeQuestion = { id: randomUUID(), sessionId, questions, done,
          answer: (value) => finish(value), cancel: (error) => finish(null, error) };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
        try {
          for (const listener of listeners) if (listener(question)) return;
          finish(null, new Error("Paseo question form is not connected"));
        } catch (error) { finish(null, error instanceof Error ? error : new Error(String(error))); }
      });
    },
  };
}

function questions(suspension: NativeSuspension) {
  const raw: unknown = suspension.request.questions;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("Aside returned an invalid question form");
  const headers = new Set<string>(["__proto__", "constructor", "prototype"]);
  return raw.map((item: unknown, index: number) => {
    if (!item || typeof item !== "object") throw new Error("Invalid Aside question");
    const question = item as Record<string, unknown>;
    if (typeof question.question !== "string" || typeof question.header !== "string" || !Array.isArray(question.options)) {
      throw new Error("Invalid Aside question fields");
    }
    // Paseo keys answers by header. Keep duplicate/empty native headers distinct
    // in the form, then restore each original header when replying to Aside.
    const base = question.header.trim() || `Question ${index + 1}`;
    let header = base;
    for (let suffix = 2; headers.has(header); suffix++) header = `${base} (${suffix})`;
    headers.add(header);
    const options = question.options.map((option: unknown) => {
      if (!option || typeof option !== "object" || typeof (option as Record<string, unknown>).label !== "string") {
        throw new Error("Invalid Aside question option");
      }
      const value = option as { label: string; description?: unknown };
      return { label: value.label, ...(typeof value.description === "string" ? { description: value.description } : {}) };
    });
    return {
      nativeHeader: question.header,
      header, question: question.question, options,
      multiSelect: question.multiple === true,
      allowOther: true,
    };
  });
}

export function questionRequest(id: string, suspension: NativeSuspension): ProviderPermissionRequest {
  return {
    id, name: "AskUserQuestion", kind: "question", title: "Aside needs your answer",
    input: { questions: questions(suspension).map(({ nativeHeader: _nativeHeader, ...question }) => question) },
  };
}

export function questionResponse(suspension: NativeSuspension, response: ProviderPermissionResponse) {
  if (response.behavior !== "allow") throw new Error("Cannot submit a declined Aside question");
  if (response.selectedActionId || response.updatedPermissions?.length) throw new Error("Invalid Aside question response");
  const answers = response.updatedInput?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new Error("Missing Aside question answers");
  const form = questions(suspension);
  const expected = new Set(form.map((question) => question.header));
  if (Object.keys(answers).some((header) => !expected.has(header))) throw new Error("Unexpected Aside question answer");
  return {
    answers: form.map((question) => {
      const value = Object.hasOwn(answers, question.header) ? answers[question.header] : undefined;
      if (typeof value !== "string" || !value.trim()) throw new Error(`Answer required: ${question.header}`);
      return { header: question.nativeHeader, answer: value.trim() };
    }),
  };
}
