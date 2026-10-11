import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";

/** Relay native Aside approval and final-action suspensions through Paseo. */
export function withAsidePermissions(provider: ProviderRegistration): ProviderRegistration;
