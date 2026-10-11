export interface NativeSuspension {
  id?: string;
  kind: "approval" | "action-confirmation" | "ask-user-question";
  toolCallId: string;
  request: Record<string, any>;
  createdAt: string;
}
export interface NativeSession {
  id: string;
  status: string;
  trigger?: { type: string; source?: string; client?: string } | null;
  permissionMode: string;
  permission?: Record<string, unknown> | null;
  runtimeConfig: { finalConfirm?: boolean; [key: string]: unknown };
  suspension?: NativeSuspension | null;
}
export function getNativeClient(config: { aside_cli?: string }): {
  getSession(accountId: number, sessionId: string): Promise<NativeSession>;
  messageRows(accountId: number, sessionId: string): Promise<Array<{ id: string; role: string; timestamp: number }>>;
  branchSession(accountId: number, sessionId: string, messageId: string): Promise<NativeSession>;
  updatePermissions(accountId: number, sessionId: string, permissionMode: string | undefined, finalConfirm: boolean): Promise<NativeSession>;
  resolveSuspension(accountId: number, sessionId: string, suspension: NativeSuspension, response: Record<string, unknown>): Promise<NativeSession>;
  rejectSuspension(accountId: number, sessionId: string, suspension: NativeSuspension, error: string): Promise<NativeSession>;
};
export function activeSuspension(session: NativeSession): NativeSuspension | null;
export function suspensionKey(suspension: NativeSuspension): string;
export function isHeadlessSession(session: NativeSession): boolean;
