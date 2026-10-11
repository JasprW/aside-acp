import type { AgentSideConnection, Stream } from "@agentclientprotocol/sdk";

/** Connect the Aside ACP bridge to caller-owned object streams. */
export function connectAsideAgent(stream: Stream, options?: {
  nativeQuestions?: boolean;
  requestQuestion?: (sessionId: string, questions: unknown[], signal: AbortSignal) => Promise<{ answers: Array<{ header: string; answer: string }> } | null>;
}): Promise<{
  connection: AgentSideConnection;
  dispose(): Promise<void>;
}>;
