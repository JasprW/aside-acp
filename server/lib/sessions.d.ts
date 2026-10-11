export interface AsideSessionSummary {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt?: string;
}
export function listAsideSessions(options?: {
  accountRoot?: string;
  sessionsRoot?: string;
  cwd?: string;
  query?: string;
  limit?: number;
}): Promise<AsideSessionSummary[]>;
export function parseNativeSessionId(sessionId: string, accountRoot: string): string | null;
export function getAsideSession(accountRoot: string, sid: string): Promise<{ sid: string; cwd: string; model: string | null; effort: string | null }>;
export function readAsideHistory(accountRoot: string, sid: string): Promise<Array<{ id: string; role: "user" | "assistant" | "reasoning"; text: string }>>;
