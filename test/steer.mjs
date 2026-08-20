#!/usr/bin/env node
// Replicate Paseo's steer sequence exactly: start a long turn, then
// cancel (fire-and-forget) and IMMEDIATELY send a steered prompt.
// Paseo's replaceAgentRun does cancelAgentRunBefore -> streamAgent(startTurn)
// back-to-back without waiting for the old turn to resolve.
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
    this.log = [];
  }
  async requestPermission(params) {
    return { outcome: { outcome: "selected", optionId: "reject" } };
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
  const check = (name, cond, extra = "") => {
    results.push(!!cond);
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  };
  try {
    await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION });
    const ns = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
    const sid = ns.sessionId;

    // long turn
    const longTurn = connection.prompt({
      sessionId: sid,
      prompt: [{ type: "text", text: "Open https://en.wikipedia.org/wiki/Singapore and https://en.wikipedia.org/wiki/Malaysia. Summarize both, take your time." }],
    });
    await new Promise((r) => setTimeout(r, 4000)); // let it get going

    // Paseo steer sequence: cancel (no await of ack) then prompt immediately
    const before = client.chunks.join("");
    const steer = connection.prompt({
      sessionId: sid,
      prompt: [{ type: "text", text: "Steer: STOP. Just tell me the population of Japan, short." }],
    });
    await connection.cancel({ sessionId: sid }); // fire-and-forget style

    const [longResult, steerResult] = await Promise.all([longTurn, steer]);
    console.log("long turn stopReason:", longResult.stopReason);
    console.log("steer stopReason:", steerResult.stopReason);

    const all = client.chunks.join("");
    check("steer executed by aside", /population of Japan|Japan/i.test(all.slice(before.length)),
      "extra=" + all.slice(before.length).slice(-160).replace(/\n/g, " "));
    check("long turn ended (cancelled or end)", ["cancelled", "end_turn"].includes(longResult.stopReason));
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
