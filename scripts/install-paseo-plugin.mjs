#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const home = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
const configPath = path.join(home, "config.json");
const run = (args) => execFileSync("paseo", [...args, "--home", home], { stdio: "inherit" });
const read = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
const write = (config) => {
  const temporary = `${configPath}.aside-acp.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, configPath);
};

if (process.argv.includes("--remove")) {
  run(["plugin", "remove", "aside-acp"]);
} else {
  const config = read();
  if (config.pluginsEnabled !== true) {
    throw new Error("Enable trusted plugins in Paseo Settings before installing Aside.");
  }
  const legacy = config.agents?.providers?.aside;
  const installed = config.plugins?.["aside-acp"];
  if (installed && (installed.source !== "directory" || path.resolve(installed.path) !== path.resolve(root))) {
    throw new Error("Aside plugin is already installed from another source; update it with Paseo's plugin commands.");
  }
  const legacyCommand = legacy?.command || [];
  const ownsLegacy = legacy?.extends === "acp" && legacyCommand.some((part) =>
    typeof part === "string" && path.resolve(part) === path.join(root, "server.js"),
  );
  if (legacy?.extends && !ownsLegacy) {
    throw new Error("Another custom provider owns the ID 'aside'; resolve that conflict first.");
  }
  if (ownsLegacy) {
    const backup = `${configPath}.before-aside-plugin-${Date.now()}`;
    fs.writeFileSync(backup, fs.readFileSync(configPath), { mode: 0o600 });
    delete config.agents.providers.aside;
    write(config);
    console.log(`Backed up config to ${backup}; migrating legacy Aside registration.`);
  }
  try {
    if (ownsLegacy) run(["reload", "--json"]);
    run(installed ? ["plugin", "reload", "aside-acp", "--json"] : ["plugin", "install", root, "--json"]);
  } catch (error) {
    if (ownsLegacy) {
      const latest = read();
      latest.agents ??= {};
      latest.agents.providers ??= {};
      latest.agents.providers.aside = legacy;
      write(latest);
      run(["reload", "--json"]);
    }
    throw error;
  }
}
