import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const historySchema = z.object({
  items: z.array(z.object({ id: z.string().min(1), role: z.enum(["user", "assistant", "reasoning"]), text: z.string() })),
});

// The ACP shim drops chunks during session/load and ignores replayed user
// chunks. Supplement replay just before ready; keep all other shim behavior.
export function withAsideHistory(provider: ProviderRegistration): ProviderRegistration {
  return {
    ...provider,
    async connect(request) {
      const connection = await provider.connect(request);
      const replay = new Map<string, string>();
      return {
        ...connection,
        send(input) {
          if (input.type === "session.open" && input.history === "replay") {
            const data = input.persistence?.data;
            if (data && typeof data === "object" && !Array.isArray(data) && typeof data.sessionId === "string") {
              replay.set(input.sessionId, data.sessionId);
            }
          }
          return connection.send(input);
        },
        onEvent(listener) {
          return connection.onEvent((event) => {
            if (event.type === "session.ready") {
              const nativeId = replay.get(event.sessionId);
              replay.delete(event.sessionId);
              if (nativeId && /^[a-zA-Z0-9_-]+$/.test(nativeId)) {
                try {
                  const saved = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".aside-acp", "sessions", `${nativeId}.json`), "utf8"));
                  const result = historySchema.safeParse({ items: saved.history || [] });
                  if (result.success) for (const item of result.data.items) {
                    listener({
                      type: "timeline.item",
                      sessionId: event.sessionId,
                      item: { type: item.role === "user" ? "user_message" : item.role === "reasoning" ? "reasoning" : "assistant_message", id: item.id, text: item.text },
                    });
                  }
                } catch (error) { console.error("Aside history replay failed", error); }
              }
            }
            listener(event);
          });
        },
        close: () => connection.close(),
      };
    },
  };
}
