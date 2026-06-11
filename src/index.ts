import { existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createBot } from "./bot.js";

const root = resolve(import.meta.dirname ?? process.cwd(), "..");

// First-run: create .env from template
if (!existsSync(resolve(root, ".env"))) {
  if (existsSync(resolve(root, ".env.example"))) {
    copyFileSync(resolve(root, ".env.example"), resolve(root, ".env"));
    console.log("Created .env from .env.example — edit it with your tokens.");
  }
}

const config = loadConfig();
const bot = createBot(config);

console.log(`
  ██╗  ██╗██╗███╗   ██╗ ██████╗ ██████╗ ███████╗██████╗
  ██║  ██║██║████╗  ██║██╔════╝ ██╔══██╗██╔════╝██╔══██╗
  ███████║██║██╔██╗ ██║██║  ███╗██████╔╝█████╗  ██║  ██║
  ██╔══██║██║██║╚██╗██║██║   ██║██╔══██╗██╔══╝  ██║  ██║
  ██║  ██║██║██║ ╚████║╚██████╔╝██║  ██║███████╗██████╔╝
  ╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═════╝
`);

// Check if mimo CLI is available
const { spawn } = await import("node:child_process");
const check = spawn("mimo", ["--version"], { stdio: "ignore" });
const mimoOk = await new Promise<boolean>((resolve) => {
  check.on("close", (code) => resolve(code === 0));
  check.on("error", () => resolve(false));
});

if (mimoOk) {
  console.log("  MiMoCode CLI:  OK");
} else {
  console.warn("  MiMoCode CLI:  NOT FOUND (install: npm i -g @mimo-ai/cli)");
}

if (config.allowedUserIds.length > 0) {
  console.log(`  Allowed users: ${config.allowedUserIds.join(", ")}`);
} else {
  console.warn("  Warning: No user whitelist — all users allowed");
}

await bot.api.setMyCommands([
  { command: "start", description: "Show help & quick actions" },
  { command: "new", description: "Start a new session" },
  { command: "status", description: "Connection & session info" },
  { command: "sessions", description: "List all sessions" },
  { command: "models", description: "List available models" },
  { command: "stats", description: "Usage statistics" },
  { command: "export", description: "Export current session" },
  { command: "providers", description: "List AI providers" },
  { command: "agent", description: "Show current agent" },
  { command: "delete", description: "Delete a session (usage: /delete <id>)" },
  { command: "version", description: "MimoCode version" },
  { command: "cancel", description: "Cancel running task" },
]);

console.log("\n  Bot started. Send /start in Telegram.\n");

await bot.start();
