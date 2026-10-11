import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";

/** Relay native Aside approvals, final confirmations and question forms through Paseo. */
export function withAsidePermissions(provider: ProviderRegistration): ProviderRegistration;
