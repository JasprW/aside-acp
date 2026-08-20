// aside-acp: enumerate aside models for Paseo's model picker.
// Reads ~/.aside/u/<n>/models.json (the same file aside exec -m reads), so
// every entry is guaranteed to be a valid qualified id: <provider>/<model>.

import fs from "node:fs";
import path from "node:path";

export const EFFORT_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// Model providers excluded from the picker regardless of catalog contents.
// opencode-go hit its weekly usage limit (GoUsageLimitError 429, 2026-08-20)
// and Jaspr prefers codex/claude providers.
const EXCLUDE_PROVIDERS = new Set(["opencode-go"]);

// aside exec -m resolves provider keys per account. Work profile (account 1)
// uses `claude-code` as the provider key for the anthropic model catalog.
const PROVIDER_ALIAS = { anthropic: "claude-code" };

function readModelsJson(accountRoot) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(accountRoot, "models.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

function readModelsCatalog(accountRoot) {
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(accountRoot, "cache", "models-catalog.json"),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
}

function flattenModels(raw, alias) {
  const providers = raw?.providers || raw || {};
  const out = [];
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || !Array.isArray(provider.models)) continue;
    const pid = alias?.[providerId] || providerId;
    if (EXCLUDE_PROVIDERS.has(pid)) continue;
    for (const m of provider.models) {
      if (!m || typeof m.id !== "string") continue;
      // Model name FIRST with provider provenance as a suffix:
      // `GPT-5.6 Sol (openai-codex)` — picker stays scannable by name and
      // still distinguishes e.g. `GPT-5.6 (compass-kb-sqp)` from codex.
      const name = m.name && m.name !== m.id ? m.name : m.id;
      out.push({
        id: `${pid}/${m.id}`,
        label: `${name} (${pid})`,
        provider: pid,
      });
    }
  }
  return out;
}

export function enumerateModels(accountRoot, approved = null) {
  // Merge two sources instead of choosing one: profile models.json (inline
  // lists for self-hosted/company providers like aicodewith-* or
  // compass-*-sqp) PLUS cache/models-catalog.json (cloud providers whose
  // catalog is lazy: openai-codex, anthropic→claude-code). Providers overlap
  // by qualified id; catalog entries that already appear from the profile
  // source are skipped.
  const modelMap = new Map();
  for (const m of flattenModels(readModelsJson(accountRoot))) {
    modelMap.set(m.id, m);
  }
  for (const m of flattenModels(readModelsCatalog(accountRoot), PROVIDER_ALIAS)) {
    if (!modelMap.has(m.id)) modelMap.set(m.id, m);
  }
  let models = [...modelMap.values()];
  if (approved && approved.length) {
    models = models.filter((m) => approved.includes(m.id) || approved.includes(m.provider));
  }
  return models;
}

export function buildConfigOptions(models, currentModel, currentEffort) {
  const options = [];
  if (models.length > 0) {
    options.push({
      type: "select",
      id: "model",
      category: "model",
      label: "Model",
      description: "Model used by aside for this session",
      currentValue: currentModel || models[0].id,
      options: models.map((m) => ({
        value: m.id,
        name: m.label,
      })),
    });
  }
  options.push({
    type: "select",
    id: "effort",
    category: "thought_level",
    label: "Thinking effort",
    description: "aside exec --effort level",
    currentValue: currentEffort,
    options: EFFORT_LEVELS.map((e) => ({ value: e, name: e })),
  });
  return options;
}

export function buildModelState(models, currentModel) {
  return {
    // Paseo's deriveModelDefinitionsFromACP reads model.name for the label
    // (acp-agent.js), while older clients may read label — provide both.
    // A missing label poisons the entire providers snapshot (zod schema
    // validation fails) → GUI providers UI stuck on "loading".
    availableModels: models.map((m) => ({
      modelId: m.id,
      label: m.label,
      name: m.label,
    })),
    currentModelId: currentModel || (models[0] ? models[0].id : null),
  };
}
