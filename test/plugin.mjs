#!/usr/bin/env node
// Live integration through the installed Paseo provider, using public pages only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../server/lib/aside.js";

const exec = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = fileURLToPath(new URL("../", import.meta.url));
const marker = `ASIDE_PLUGIN_${randomUUID().replaceAll("-", "")}`;
const mappings = path.join(os.homedir(), ".aside-acp", "sessions");
let agentId;
let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); console.log(`PASS ${name}`); passed++; };
async function cli(args, json = true) {
  const { stdout } = await exec("paseo", [...args, ...(json ? ["--json"] : [])], {
    cwd: root, timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  });
  if (!json) return stdout;
  try { return JSON.parse(stdout); }
  catch {
    const start = stdout.search(/^[{[]/m);
    if (start >= 0) return JSON.parse(stdout.slice(start));
    throw new Error(`Expected Paseo JSON output: ${stdout}`);
  }
}
const inspect = () => cli(["inspect", agentId]);
const logs = () => cli(["logs", agentId, "--tail", "100"], false);
const wait = () => cli(["wait", agentId, "--timeout", "120"]);
const send = (prompt, background = false) => cli(["send", agentId, ...(background ? ["--no-wait"] : []), prompt]);
function mapping() {
  for (const name of fs.readdirSync(mappings)) {
    if (!name.endsWith(".json")) continue;
    const saved = JSON.parse(fs.readFileSync(path.join(mappings, name), "utf8"));
    if (saved.history?.some((item) => item.role === "user" && item.text.includes(marker))) return saved;
  }
  throw new Error("Test session mapping was not persisted");
}
try {
  const plugins = await cli(["plugin", "ls"]);
  check("installed plugin is running", plugins.some((plugin) => plugin.id === "aside-acp" && plugin.status === "running"));
  const models = await cli(["provider", "models", "aside"]);
  const model = loadConfig().default_model || models[0]?.id;
  check("model catalog is available", models.length > 0 && models.some((item) => item.id === model));
  const run = await cli(["run", "--background", "--provider", "aside", "--model", model,
    "--thinking", "high", "--title", "Aside provider integration test", "--cwd", root,
    `Open https://example.com in the browser and tell me the exact page title. Read only; do not change anything. Remember ${marker} only in this conversation.`]);
  agentId = run.agentId;
  check("Paseo creates an Aside agent", !!agentId);
  await wait();
  check("real browser task completes", (await inspect()).Status === "idle" && /Example Domain/i.test(await logs()));
  const nativeId = mapping().asideSid;
  check("chosen model and thinking reach the bridge", mapping().model === model && mapping().effort === "high");

  await cli(["plugin", "reload", "aside-acp"]);
  await cli(["agent", "reload", agentId]);
  check("history replays after plugin reload", /Example Domain/i.test(await logs()));
  await send("What exact ASIDE_PLUGIN token did I ask you to remember? Reply only with that token; do not use tools.");
  check("resumed session keeps context", mapping().asideSid === nativeId && mapping().history.at(-1).text.includes(marker));
  await cli(["agent", "reload", agentId]);
  check("both conversation turns replay", /Example Domain/i.test(await logs()) && (await logs()).includes("What exact ASIDE_PLUGIN token"));

  await send("SIMULATION ONLY: do not send anything or perform any external action. Pretend you want to send a test email to test@example.com. Follow the bridge protocol and output exactly an [[APPROVAL]] block asking permission for that simulated email.", true);
  let permission;
  for (let i = 0; i < 60; i++) {
    const state = await inspect();
    permission = state.PendingPermissions?.[0];
    if (permission) break;
    if (state.Status === "error") throw new Error("Approval task failed");
    await pause(1000);
  }
  check("approval reaches Paseo", !!permission);
  await cli(["permit", "deny", agentId, "--all", "--message", "Simulation denied; perform no external action."]);
  await wait();
  check("approval denial resolves", (await inspect()).Status === "idle" && (await inspect()).PendingPermissions.length === 0);

  await send("Open https://en.wikipedia.org/wiki/Singapore and https://en.wikipedia.org/wiki/Malaysia in the browser and compare both articles in great detail. Read only.", true);
  await pause(2000);
  await cli(["stop", agentId]);
  await wait();
  await send("Reply exactly CANCEL_RECOVERED. Do not use tools.");
  check("cancel can be followed by another turn", mapping().history.at(-1).text.includes("CANCEL_RECOVERED"));

  await send("[model:aside-plugin-nonexistent/test] Reply TEST_ERROR.").catch(() => {});
  check("invalid model produces a visible error", /Unknown Aside model/.test(await logs()));
  await cli(["agent", "reload", agentId]);
  await send("Reply exactly ERROR_RECOVERED. Do not use tools.");
  check("provider recovers after an error", (await inspect()).Status === "idle" && mapping().history.at(-1).text.includes("ERROR_RECOVERED"));

  await send("Open https://en.wikipedia.org/wiki/Singapore and compare its contents against https://en.wikipedia.org/wiki/Malaysia in great detail. Read only.", true);
  await pause(2000);
  await cli(["plugin", "reload", "aside-acp"]);
  await cli(["agent", "reload", agentId]);
  await send("Reply exactly RELOAD_RECOVERED. Do not use tools.");
  check("active plugin reload can resume the same session", mapping().asideSid === nativeId && mapping().history.at(-1).text.includes("RELOAD_RECOVERED"));
  console.log(`\n${passed}/${passed} integration checks passed`);
} finally {
  if (agentId) await cli(["archive", agentId]).catch((error) => console.error("Test agent cleanup failed", error.message));
}
