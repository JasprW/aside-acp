/** Keep the upstream reason without exposing its entire JSON envelope in the UI. */
export function providerErrorMessage(error) {
  let value = error;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { /* plain-text provider error */ }
  }
  const detail = value && typeof value === "object" ? value.error ?? value : null;
  const reason = typeof detail?.message === "string" ? detail.message : String(error);
  const requestId = typeof value?.request_id === "string" ? value.request_id : null;
  return `Aside model provider: ${reason}${requestId ? ` (request ID: ${requestId})` : ""}`;
}
