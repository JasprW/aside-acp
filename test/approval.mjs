#!/usr/bin/env node
// approval-flow test: the aside agent must end its turn with an
// [[APPROVAL]] block; the server translates it to an ACP requestPermission;
// the client approves; the server injects the grant and the agent continues.
// The task is explicitly a SIMULATION — nothing real is sent/deleted.
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
    this.permissionCalls = [];
  }
  async requestPermission(params) {
    this.permissionCalls.push(params);
    return { outcome: { outcome: "selected", optionId: "allow" } };
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

async function main() {
  const agentProcess = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const input = Writable.toWeb(agentProcess.stdin);
  const output = Readable.toWeb(agentProcess.stdout);
  const client = new TestClient();
  const stream = acp.ndJsonStream(input, output);
  const connection = new acp.ClientSideConnection(() => client, stream);
  const results = [];
  const check = (name, cond) => {
    results.push(cond);
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  };
  try {
    await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION });
    const ns = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
    const sid = ns.sessionId;

    const promptResult = await connection.prompt({
      sessionId: sid,
      prompt: [{
        type: "text",
        text: "SIMULATION ONLY — do not actually send anything or perform any real action. " +
          "Pretend you want to send an email to test@example.com with subject 'test' and body 'hi'. " +
          "Per your protocol, stop and post an approval request for that action.",
      }],
    });

    check("turn completed", promptResult.stopReason === "end_turn");
    check("permission requested", client.permissionCalls.length > 0,
      `calls=${client.permissionCalls.length}`);
    if (client.permissionCalls[0]) {
      check("permission title matches action", /email/i.test(client.permissionCalls[0].toolCall.title || ""));
      check("allow+reject options", client.permissionCalls[0].options.length === 2);
    }
    const all = client.chunks.join("");
    const afterApproval = all.slice(all.lastIndexOf("[[/APPROVAL]]"));
    check("agent continued after approval", afterApproval.trim().length > 50,
      afterApproval.trim().slice(0, 150));
    console.log("\n--- last chunks ---");
    console.log(all.slice(-400));
  } catch (e) {
    console.error("ERROR:", e);
    results.push(false);
  } finally {
    try { agentProcess.kill(); } catch {}
    const failed = results.filter((r) => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exitCode = failed ? 1 : 0;
  }
}

main();
