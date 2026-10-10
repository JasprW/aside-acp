// aside-acp: map the soft [[QUESTION]] protocol to ACP elicitation (form mode)
// when the client advertises `clientCapabilities.elicitation.form`; fall back
// to the plain text block otherwise. Pure functions only — no I/O.
//
// QUESTION format (from persona.js):
//   [[QUESTION]]
//   {"questions":[{"header":"...","question":"...","options":[{"label":"A","description":"..."}]}]}
//   [[/QUESTION]]

export function hasFormElicitation(clientCapabilities) {
  const el = clientCapabilities?.elicitation;
  return !!(el && el.form);
}

/**
 * Build the `requestedSchema` for an elicitation/create form-mode request.
 * Each question becomes a string property:
 *   - with options  -> string + oneOf ([{const, title, description?}])
 *   - without       -> plain string
 * All properties are required.
 */
export function questionsToSchema(questions) {
  const properties = {};
  const required = [];
  questions.forEach((q, i) => {
    const key = `q${i + 1}`;
    required.push(key);
    const base = {
      title: q.header || q.question || `Question ${i + 1}`,
      description: q.question || undefined,
    };
    const options = q.options || [];
    if (options.length > 0) {
      properties[key] = {
        type: "string",
        ...base,
        oneOf: options.map((label, oi) => {
          const desc = q.optionDescriptions?.[oi];
          return {
            const: label,
            title: label,
            ...(desc ? { description: desc } : {}),
          };
        }),
      };
    } else {
      properties[key] = { type: "string", ...base };
    }
  });
  return { type: "object", properties, required };
}

/**
 * Format an accepted elicitation content back into the reply text injected
 * into aside, mirroring the text-protocol style ("the owner answered").
 * content is { q1: "...", q2: "..." }.
 */
export function acceptedReplyText(content, questions) {
  if (!content || typeof content !== "object") return "";
  const lines = [];
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const val = content[`q${i + 1}`];
    if (val === undefined || val === null) continue;
    const shown = Array.isArray(val) ? val.join(", ") : String(val);
    const label = q.header || q.question || `Question ${i + 1}`;
    lines.push(`${label}: ${shown}`);
  }
  if (lines.length === 0) return "";
  return `[QUESTION ANSWERED by the owner]\n${lines.join("\n")}\n\nThe owner has answered your question above. Continue your task using that answer now.`;
}

export function declinedReplyText() {
  return "[QUESTION DECLINED by the owner] The owner declined to answer your question. Do not block on it — acknowledge briefly, use your best judgment, and continue with the task or stop if you cannot proceed.";
}
