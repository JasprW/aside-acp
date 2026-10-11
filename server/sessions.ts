import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { listAsideSessions } from "./lib/sessions.js";

/** Keep search/filter/limit ordering correct instead of ACP shim's early slicing. */
export function withAsideSessions(provider: ProviderRegistration): ProviderRegistration {
  return {
    ...provider,
    async connect(request) {
      const connection = await provider.connect(request);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const emit = (event: ProviderEvent) => { for (const listener of listeners) listener(event); };
      const unsubscribe = connection.onEvent(emit);
      let closed = false;
      return {
        ...connection,
        async send(input) {
          if (input.type !== "sessions") return connection.send(input);
          if (closed) throw new Error("Aside plugin connection is closed");
          const sessions = await listAsideSessions({ cwd: input.cwd, query: input.query, limit: input.limit });
          if (!closed) emit({
            type: "sessions",
            requestId: input.requestId,
            sessions: sessions.map(({ sessionId, ...summary }) => ({
              ...summary,
              persistence: { version: 1, data: { sessionId } },
            })),
          });
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        async close() {
          closed = true;
          unsubscribe();
          listeners.clear();
          await connection.close();
        },
      };
    },
  };
}
