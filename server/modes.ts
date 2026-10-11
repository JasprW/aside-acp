import type { AcpTransformer } from "@getpaseo/plugin/server/acp";

/** "auto" was a placeholder, never a native Aside permission mode. */
export const legacyAsideMode: AcpTransformer = {
  async configure(change) {
    return change.target === "mode" && change.value === "auto" ? "handled" : "pass";
  },
};
