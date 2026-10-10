#!/usr/bin/env node
// Standalone ACP entry. The Paseo plugin uses the same bridge over object streams.
import { Writable, Readable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { connectAsideAgent } from "./server/agent.js";

try {
  const { connection, dispose } = await connectAsideAgent(ndJsonStream(
    Writable.toWeb(process.stdout), Readable.toWeb(process.stdin),
  ));
  await connection.closed;
  await dispose();
} catch (error) {
  console.error(`[aside-acp] fatal: ${error.stack || error}`);
  process.exitCode = 1;
}
