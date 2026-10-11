import type { AcpConnector, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { connectAsideAgent } from "./agent.js";
import { createAsideQuestionRelay } from "./permissions.js";

/** Object streams avoid launching Node from an installation-specific file path. */
export function createAsideConnector() {
  const questions = createAsideQuestionRelay();
  const connections = new Set<Awaited<ReturnType<typeof connectAsideAgent>>>();
  let disposed = false;
  const connect: AcpConnector = async () => {
    if (disposed) throw new Error("Aside plugin has been unloaded");
    const toAgent = new TransformStream<AcpStreamMessage, AcpStreamMessage>();
    const toClient = new TransformStream<AcpStreamMessage, AcpStreamMessage>();
    const agent = await connectAsideAgent({
      writable: toClient.writable,
      readable: toAgent.readable,
    }, { nativeQuestions: true, requestQuestion: questions.request });
    if (disposed) {
      await agent.dispose();
      throw new Error("Aside plugin was unloaded while connecting");
    }
    connections.add(agent);
    void agent.connection.closed.then(() => connections.delete(agent));
    return { writable: toAgent.writable, readable: toClient.readable };
  };
  return {
    connect,
    questions,
    async dispose() {
      disposed = true;
      await Promise.all([...connections].map((agent) => agent.dispose()));
      connections.clear();
    },
  };
}
