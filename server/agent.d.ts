import type { AgentSideConnection, Stream } from "@agentclientprotocol/sdk";

/** Connect the Aside ACP bridge to caller-owned object streams. */
export function connectAsideAgent(stream: Stream, options?: { nativeQuestions?: boolean }): Promise<{
  connection: AgentSideConnection;
  dispose(): Promise<void>;
}>;
