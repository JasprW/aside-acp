#!/usr/bin/env node
// E2E for ACP session resume (Paseo 0.4.x behavior):
// 1. spawn server, initialize, newSession, prompt once (bootstrap + turn)
// 2. kill the server process (agent goes idle -> Paseo closes child)
// 3. spawn a NEW server process, initialize, loadSession(sessionId)
// 4. prompt on the resumed session -> must reuse the same aside session
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import fs from "node:fs";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "server.js");

class TestClient {
  constructor() {
    this.chunks = [];
    this.log = [];
  }
  async requestPermission() {
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

function connect() {
  const agentProcess = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const input = Writable.toWeb(agentProcess.stdin);
  const output = Readable.toWeb(agentProcess.stdout);
  const client = new TestClient();
  const stream = acp.ndJsonStream(input, output);
  const connection = new acp.ClientSideConnection(() => client, stream);
  return { agentProcess, connection, client };
}

async function main() {
  const results = [];
  const check = (name, cond, extra = "") => {
    results.push(!!cond);
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  };

  // ---- first connection: bootstrap + one turn ----------------------------
  let { agentProcess, connection, client } = connect();
  let sessionId;
  let asideSessionDir = null;
  try {
    const init = await connection.initialize({ protocolVersion: acp.PROTOCOL_VERSION });
    check("initialize advertises loadSession", init.agentCapabilities?.loadSession === true);
    const ns = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
    sessionId = ns.sessionId;
    check("newSession returns id", !!sessionId);

    const res = await connection.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Reply with the word RESUME-READY only." }],
    });
    check("first prompt end_turn", res.stopReason === "end_turn");
    const first = client.chunks.join("");
    check("first answer present", /RESUME-READY/i.test(first));

    // read the bound aside session from the persist file (find-newest is
    // unreliable here: concurrent cron aside sessions can race it)
    const persistFile = join(os.homedir(), ".aside-acp", "sessions", `${sessionId}.json`);
    check("persist file written", fs.existsSync(persistFile), persistFile);
    const saved0 = JSON.parse(fs.readFileSync(persistFile, "utf8"));
    asideSessionDir = saved0.asideSid;
    check("aside session bound", !!asideSessionDir, asideSessionDir ?? "none");
  } finally {
    agentProcess.kill("SIGKILL");
    connection = null;
  }

  // persist file must exist now
  const persistFile = join(os.homedir(), ".aside-acp", "sessions", `${sessionId}.json`);

  // ---- second connection: resume -----------------------------------------
  const { agentProcess: proc2, connection: conn2, client: client2 } = connect();
  let resumedAside = null;
  try {
    await conn2.initialize({ protocolVersion: acp.PROTOCOL_VERSION });
    const ls = await conn2.loadSession({ sessionId, cwd: process.cwd(), mcpServers: [] });
    check("loadSession returns configOptions", Array.isArray(ls.configOptions) && ls.configOptions.length > 0);

    client2.chunks.length = 0;
    const res2 = await conn2.prompt({
      sessionId,
      prompt: [{ type: "text", text: "Now reply with the word RESUMED-OK only." }],
    });
    check("resumed prompt end_turn", res2.stopReason === "end_turn");
    const second = client2.chunks.join("");
    check("resumed answer present", /RESUMED-OK/i.test(second), second.slice(-80).replace(/\n/g, " "));

    // verify the persisted asideSid was reused (same aside session)
    const saved = JSON.parse(fs.readFileSync(persistFile, "utf8"));
    check("persisted asideSid primed", saved.primed === true);
    check("persist still points at original aside session", saved.asideSid === asideSessionDir,
      `${saved.asideSid} vs ${asideSessionDir}`);
  } finally {
    conn2.close?.().catch?.(() => {});
    try { proc2.kill("SIGKILL"); } catch {}
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exitCode = 1;
});
