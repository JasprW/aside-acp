import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import type { AsideQuestionRelay } from "./questions.js";
export { createAsideQuestionRelay } from "./questions.js";

/** Relay native Aside approvals, final confirmations and question forms through Paseo. */
export function withAsidePermissions(provider: ProviderRegistration, questions?: AsideQuestionRelay): ProviderRegistration;
