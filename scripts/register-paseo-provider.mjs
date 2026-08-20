#!/usr/bin/env node
// Register aside-acp as a Paseo custom ACP provider.
// Adds/updates agents.providers.aside in ~/.paseo/config.json (with backup).
// Usage: node scripts/register-paseo-provider.mjs [--remove]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CFG = path.join(os.homedir(), ".paseo", "config.json");
const SERVER = path.join(process.cwd(), "server.js");
const NODE = process.execPath;

const PROVIDER = {
  aside: {
    extends: "acp",
    label: "Aside (Browser Agent)",
    description: "Aside browser agent via aside-acp (ACP bridge)",
    command: [NODE, SERVER],
    params: { supportsMcpServers: false },
  },
};

function main() {
  const remove = process.argv.includes("--remove");
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CFG, "utf8"));
  } catch (e) {
    console.error(`cannot read ${CFG}: ${e.message}`);
    process.exit(1);
  }
  cfg.agents ??= {};
  cfg.agents.providers ??= {};
  if (remove) {
    if (cfg.agents.providers.aside) {
      delete cfg.agents.providers.aside;
      fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + "\n");
      console.log("removed aside provider");
    } else {
      console.log("aside provider not present; nothing to do");
    }
    return;
  }
  cfg.agents.providers.aside = PROVIDER.aside;
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + "\n");
  console.log("registered aside provider:");
  console.log(JSON.stringify(PROVIDER, null, 2));
  console.log(`\nrestart the daemon for it to take effect:`);
  console.log(`  launchctl unload ~/Library/LaunchAgents/com.paseo.daemon.plist`);
  console.log(`  launchctl load -w ~/Library/LaunchAgents/com.paseo.daemon.plist`);
}

main();
