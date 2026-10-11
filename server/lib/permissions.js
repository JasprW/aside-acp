// Native Aside permission modes, matching its desktop selector.
export const PERMISSION_MODES = [
  {
    id: "read-only",
    name: "Read only",
    description: "Can only work in this task’s folder. Won’t access other folders.",
  },
  {
    id: "guard",
    name: "Guard",
    description: "Can work in Documents, Downloads, and this task’s folder. Asks before accessing other folders.",
  },
  {
    id: "full-access",
    name: "Full access",
    description: "Can read and write anywhere on this computer.",
  },
];

export function isPermissionMode(value) {
  return PERMISSION_MODES.some((mode) => mode.id === value);
}

export function buildPermissionState(currentModeId) {
  return { currentModeId, availableModes: PERMISSION_MODES };
}

export const CONFIRMATION_OPTIONS = [
  { value: "ask-first", name: "Ask first" },
  { value: "skip-confirmation", name: "Skip confirmation" },
];

export function defaultFinalConfirm(config) {
  return config.default_permission !== "read-only" && config.default_confirmation !== "skip-confirmation";
}

export function confirmationOption(st) {
  return {
    id: "confirmation", type: "select", name: "Final confirm",
    description: st.permissionMode === "read-only"
      ? "Aside disables Final confirm in Read only mode."
      : "Ask before actions like send, pay, delete, or submit.",
    currentValue: st.finalConfirm ? "ask-first" : "skip-confirmation",
    options: st.permissionMode === "read-only" ? CONFIRMATION_OPTIONS.slice(1) : CONFIRMATION_OPTIONS,
  };
}
