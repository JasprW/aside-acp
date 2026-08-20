#!/usr/bin/env node
// aside-acp elicitation tests:
//  A. pure-function unit tests for lib/elicitation.js
//  B. E2E: client advertises elicitation.form → [[QUESTION]] is upgraded to a
//     real elicitation/create → client accepts → answer injected → aside
//     continues the turn with the answer.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  hasFormElicitation,
  questionsToSchema,
  acceptedReplyText,
  declinedReplyText,
} from "../lib/elicitation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "server.js");

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
}

// ---------- A. unit tests ----------
function unitTests() {
  check("hasFormElicitation detects form", hasFormElicitation({ elicitation: { form: {} } }) === true);
  check("hasFormElicitation false on null", hasFormElicitation({ elicitation: null }) === false);
  check("hasFormElicitation false when absent", hasFormElicitation(undefined) === false);
  check("hasFormElicitation false on url-only", hasFormElicitation({ elicitation: { url: {} } }) === false);

  const questions = [
    {
      header: "Language",
      question: "Which language?",
      options: ["Python", "Go", "Rust"],
      optionDescriptions: ["easy", "concurrent", "systems"],
    },
  ];
  const schema = questionsToSchema(questions);
  check("schema type object", schema.type === "object");
  check("schema has q1 property", !!schema.properties?.q1);
  check("schema q1 oneOf 3 options", schema.properties.q1.oneOf?.length === 3);
  check("schema oneOf option title", schema.properties.q1.oneOf[0]?.title === "Python");
  check("schema oneOf option description", schema.properties.q1.oneOf[2]?.description === "systems");
  check("schema required [q1]", Array.isArray(schema.required) && schema.required.includes("q1"));

  const freeform = questionsToSchema([{ header: "H", question: "Tell me", options: [] }]);
  check("freeform no oneOf", freeform.properties.q1.oneOf === undefined);

  const reply = acceptedReplyText({ q1: "Python" }, questions);
  check("acceptedReplyText includes answer", reply.includes("Language: Python"));
  check("acceptedReplyText includes directive", reply.includes("Continue your task"));

  const declined = declinedReplyText();
  check("declinedReplyText marks declined", declined.includes("DECLINED"));
}

// ---------- B. E2E ----------
class ElicitClient {
  constructor() {
    this.chunks = [];
    this.elicitationRequests = [];
    this.autoAcceptValue = "Python";
    this.respond = null; // set by the test to control timing
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
  async unstable_createElicitation(params) {
    this.elicitationRequests.push(params);
    if (this.respond) return await this.respond(params);
    // First question: answer it. Follow-up questions (aside loves to ask
    // several in a row): decline, so the test terminates.
    if (this.elicitationRequests.length === 1) {
      return { action: "accept", content: { q1: this.autoAcceptValue } };
    }
    return { action: "decline" };
  }
  async writeTextFile() { return {}; }
  async readTextFile() { return { content: "" }; }
}

function connect(client) {
  const agentProcess = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ASIDE_ACP_CONFIG: process.env.ASIDE_ACP_CONFIG || "" },
  });
  const input = Writable.toWeb(agentProcess.stdin);
  const output = Readable.toWeb(agentProcess.stdout);
  const stream = acp.ndJsonStream(input, output);
  const connection = new acp.ClientSideConnection(() => client, stream);
  return { agentProcess, connection };
}

async function e2eTest() {
  const client = new ElicitClient();
  const { agentProcess, connection } = connect(client);
  try {
    // advertise form elicitation (like Zed does)
    const init = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        elicitation: { form: {} },
      },
    });
    check("initialize ok", init.protocolVersion === acp.PROTOCOL_VERSION);

    const ns = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
    check("newSession ok", !!ns.sessionId);

    // ask aside to POST a [[QUESTION]] and wait for the answer
    const promptP = connection.prompt({
      sessionId: ns.sessionId,
      prompt: [
        {
          type: "text",
          text:
            "You must ask me which programming language to use for a new project. " +
            "Ask using the [[QUESTION]] block format from your instructions, exactly, " +
            "with options Python, Go, Rust. End your turn after posting it. Read only.",
        },
      ],
    });

    // wait for the elicitation/create request to arrive (aside turn is real)
    const deadline = Date.now() + 180000;
    while (client.elicitationRequests.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    check("elicitation/create arrived", client.elicitationRequests.length === 1,
      `${client.elicitationRequests.length} request(s)`);

    if (client.elicitationRequests.length > 0) {
      const req = client.elicitationRequests[0];
      check("elicitation mode form", req.mode === "form");
      check("elicitation sessionId matches", req.sessionId === ns.sessionId);
      check("elicitation has message", typeof req.message === "string" && req.message.length > 0);
      const schema = req.requestedSchema;
      check("elicitation schema oneOf 3", schema?.properties?.q1?.oneOf?.length === 3,
        JSON.stringify(schema?.properties?.q1).slice(0, 100));
      console.log(`  message: ${req.message.slice(0, 80)}`);
      console.log(`  schema: ${JSON.stringify(schema).slice(0, 200)}`);
    }

    const promptResult = await promptP;
    check("prompt completed end_turn", promptResult.stopReason === "end_turn",
      `stopReason=${promptResult.stopReason}`);

    const all = client.chunks.join("");
    check("final answer acknowledges Python", /python/i.test(all), all.slice(-300));
    console.log(`  --- aside final ---\n${all.slice(-400)}\n  -------------------`);
  } finally {
    try { agentProcess.kill(); } catch {}
  }
}

async function main() {
  console.log("== A. unit tests ==");
  unitTests();
  console.log("\n== B. E2E (real aside, elicitation upgrade) ==");
  await e2eTest();
  console.log("\n=== SUMMARY ===");
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error("TEST ERROR:", e);
  process.exit(1);
});
