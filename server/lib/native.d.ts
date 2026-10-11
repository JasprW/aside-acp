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
  permissionMode: string;
  runtimeConfig: { finalConfirm?: boolean; [key: string]: unknown };
  suspension?: NativeSuspension | null;
}
export function getNativeClient(config: { aside_cli?: string }): {
  getSession(accountId: number, sessionId: string): Promise<NativeSession>;
  updatePermissions(accountId: number, sessionId: string, permissionMode: string | undefined, finalConfirm: boolean): Promise<NativeSession>;
  resolveSuspension(accountId: number, sessionId: string, suspension: NativeSuspension, response: Record<string, unknown>): Promise<NativeSession>;
  rejectSuspension(accountId: number, sessionId: string, suspension: NativeSuspension, error: string): Promise<NativeSession>;
};
export function activeSuspension(session: NativeSession): NativeSuspension | null;
export function suspensionKey(suspension: NativeSuspension): string;
