import type { AgentSideConnection, Stream } from "@agentclientprotocol/sdk";

/** Connect the Aside ACP bridge to caller-owned object streams. */
export function connectAsideAgent(stream: Stream): Promise<{
  connection: AgentSideConnection;
  dispose(): Promise<void>;
}>;
