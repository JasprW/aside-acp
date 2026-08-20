#!/usr/bin/env node
// aside-acp end-to-end test: drives server.js with the official SDK client,
// exactly the way Paseo's ACPAgentClient does (initialize → newSession →
// prompt → stream → cancel).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "server.js");

class TestClient {
  constructor() {
    this.chunks = [];
    this.permissions = [];
    this.permissionResolver = null;
  }
  async requestPermission(params) {
    this.permissions.push(params);
    // auto-deny unless the test explicitly resolves
    return this.permissionResolver
      ? await this.permissionResolver(params)
      : { outcome: { outcome: "selected", optionId: "reject" } };
  }
  async sessionUpdate(params) {
    const u = params.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
      this.chunks.push(u.content.text);
    }
  }
  async writeTextFile() { return {}; }
  async readTextFile() { return { content: "" }; }
}

function connect() {
  const agentProcess = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ASIDE_ACP_CONFIG: process.env.ASIDE_ACP_CONFIG || "" },
  });
  const input = Writable.toWeb(agentProcess.stdin);
  const output = Readable.toWeb(agentProcess.stdout);
  const client = new TestClient();
  const stream = acp.ndJsonStream(input, output);
  const connection = new acp.ClientSideConnection(() => client, stream);
  return { agentProcess, connection, client };
}

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
}

async function main() {
  const { agentProcess, connection, client } = connect();
  try {
    // 1. initialize
    const init = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    check("initialize", init.protocolVersion === acp.PROTOCOL_VERSION);
    check("agentInfo", init.agentInfo?.name === "aside-acp");

    // 2. newSession
    const ns = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
    check("newSession returns id", !!ns.sessionId);
    const sid = ns.sessionId;
    check("configOptions includes model", Array.isArray(ns.configOptions) && ns.configOptions.some((o) => o.id === "model"));
    console.log(`  models available: ${ns.models?.availableModels?.length ?? 0}`);

    // 3. prompt — read-only task
    const t0 = Date.now();
    const promptResult = await connection.prompt({
      sessionId: sid,
      prompt: [{ type: "text", text: "Open https://example.com and tell me the page title. Read only, do not modify anything." }],
    });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    check("prompt stopReason end_turn", promptResult.stopReason === "end_turn", `stopReason=${promptResult.stopReason}`);
    const all = client.chunks.join("");
    check("streamed chunks received", client.chunks.length > 0, `${client.chunks.length} chunks, ${elapsed}s`);
    check("answer mentions Example Domain", /example domain/i.test(all), all.slice(0, 120));
    console.log(`  --- aside said ---\n${all.slice(0, 600)}\n  -------------------`);

    // 4. setSessionConfigOption effort
    await connection.setSessionConfigOption({
      sessionId: sid,
      configId: "effort",
      value: "high",
    });
    check("setSessionConfigOption(high) ok", true);

    // 5. cancel test — start a long task, cancel quickly
    client.chunks.length = 0;
    const cancelP = connection.prompt({
      sessionId: sid,
      prompt: [{ type: "text", text: "Open https://en.wikipedia.org/wiki/Special:Random and summarize the entire article in detail." }],
    });
    await new Promise((r) => setTimeout(r, 1500));
    await connection.cancel({ sessionId: sid });
    const cancelResult = await cancelP;
    check("cancel → stopReason cancelled", cancelResult.stopReason === "cancelled", `stopReason=${cancelResult.stopReason}`);

    console.log("\n=== SUMMARY ===");
    const failed = results.filter((r) => !r.ok);
    console.log(`${results.length - failed.length}/${results.length} passed`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    try { agentProcess.kill(); } catch {}
  }
}

main().catch((e) => {
  console.error("TEST ERROR:", e);
  process.exit(1);
});
