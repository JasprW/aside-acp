import assert from "node:assert/strict";
import { test } from "node:test";
import { AsideACP } from "../server/agent.js";
import { buildConfigOptions } from "../server/lib/models.js";

const models = [{ id: "test/model", label: "Test model", provider: "test" }];
const fixture = async () => {
  const updates = [];
  const agent = new AsideACP({ sessionUpdate: async (value) => { updates.push(value); } }, {
    default_model: "test/model", default_effort: "medium", style: "formal",
  });
  agent.models = models;
  const created = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  return { agent, created, updates };
};

test("configuration options use ACP names and categories", () => {
  const options = buildConfigOptions(models, "test/model", "medium");
  assert.equal(options[0].name, "Model");
  assert.equal(options[1].name, "Thinking effort");
  assert.equal(options[1].category, "thought_level");
});
test("discovery creates no native Aside session", async () => {
  const { agent, created } = await fixture();
  assert.match(created.sessionId, /^[a-zA-Z0-9_-]+$/);
  assert.equal(agent.sessions.get(created.sessionId).asideSid, null);
});
test("configuration changes return and notify the full option list", async () => {
  const { agent, created, updates } = await fixture();
  const result = await agent.setSessionConfigOption({ sessionId: created.sessionId, configId: "effort", value: "high" });
  assert.equal(result.configOptions.length, 2);
  assert.equal(result.configOptions[1].currentValue, "high");
  assert.deepEqual(updates.at(-1).update.configOptions, result.configOptions);
});
test("invalid effort is rejected without changing state", async () => {
  const { agent, created } = await fixture();
  await assert.rejects(agent.setSessionConfigOption({ sessionId: created.sessionId, configId: "effort", value: "unknown" }), /Unknown Aside configuration/);
  assert.equal(agent.sessions.get(created.sessionId).effort, "medium");
});
test("invalid model and mode produce explicit ACP errors", async () => {
  const { agent, created } = await fixture();
  await assert.rejects(agent.setSessionConfigOption({ sessionId: created.sessionId, configId: "model", value: "missing/model" }), (error) => error.code === -32602 && /Unknown Aside model/.test(error.message));
  await assert.rejects(agent.setSessionMode({ sessionId: created.sessionId, modeId: "unknown" }), /Unknown Aside mode/);
});
test("session IDs cannot escape the mapping directory", async () => {
  const { agent } = await fixture();
  await assert.rejects(agent.loadSession({ sessionId: "../config" }), /Invalid ACP session ID/);
});
