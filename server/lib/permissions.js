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
