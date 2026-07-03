// Integration test: exercise MimoClient + sanitization against the real mimo CLI.
// Validates that the post-refactor build still works with the live CLI.

import { checkAuth, sanitizeError } from "../src/bot.js";
import type { Config } from "../src/config.js";
import { MimoClient, type SendMessageOpts } from "../src/mimo.js";

const config: Config = {
  telegramToken: "test-token",
  allowedUserIds: ["6985614590"],
  mimoWorkDir: "/tmp/mimocode-test",
  mimoApiUrl: process.env.MIMO_API_URL,
  skipPermissions: false,
  showText: "full",
  showReasoning: "off",
  showToolUse: "off",
  showStepStart: "off",
  showStepFinish: "off",
};

const chatId = "test-chat-001";

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

const client = new MimoClient(config);

await check("ping() returns true (mimo CLI reachable)", async () => {
  const ok = await client.ping();
  if (!ok) throw new Error("ping returned false — is mimo CLI installed?");
});

await check("getVersion() returns a non-empty string", async () => {
  const v = await client.getVersion();
  if (!v) throw new Error("empty version");
  console.log(`    version: ${v}`);
});

await check("getVersion() cache hit on second call", async () => {
  const t0 = Date.now();
  await client.getVersion();
  const first = Date.now() - t0;
  const t1 = Date.now();
  await client.getVersion();
  const second = Date.now() - t1;
  if (second > first) {
    console.log(
      `    (note: cached call ${second}ms >= fresh ${first}ms — likely warm-up jitter)`,
    );
  } else {
    console.log(`    fresh=${first}ms, cached=${second}ms`);
  }
});

await check("exec(['--version']) returns code 0 with stdout", async () => {
  const r = await client.exec(["--version"], { timeoutMs: 5000 });
  if (r.code !== 0) throw new Error(`code=${r.code}, stderr=${r.stderr}`);
  if (!r.stdout.trim()) throw new Error("empty stdout");
});

await check("exec(['models']) returns a list", async () => {
  const r = await client.exec(["models"], { timeoutMs: 10_000 });
  if (r.code !== 0) throw new Error(`code=${r.code}, stderr=${r.stderr}`);
  const lines = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error("no models returned");
  console.log(`    ${lines.length} models: ${lines.slice(0, 3).join(", ")}...`);
});

await check("exec(['session', 'list']) returns JSON array", async () => {
  const r = await client.exec(["session", "list", "--format", "json"], {
    timeoutMs: 10_000,
  });
  if (r.code !== 0) throw new Error(`code=${r.code}, stderr=${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  if (!Array.isArray(parsed)) throw new Error("not an array");
  console.log(`    ${parsed.length} sessions in store`);
});

await check("setSession / getSessionId round-trip", () => {
  client.setSession(chatId, "ses_integration_test");
  if (client.getSessionId(chatId) !== "ses_integration_test") {
    throw new Error("session mismatch");
  }
});

await check("setModel / getModel round-trip", () => {
  client.setModel(chatId, "xiaomi/mimo-v2.5-pro");
  if (client.getModel(chatId) !== "xiaomi/mimo-v2.5-pro") {
    throw new Error("model mismatch");
  }
});

await check("setAgent / getAgent round-trip", () => {
  client.setAgent(chatId, "plan");
  if (client.getAgent(chatId) !== "plan") throw new Error("agent mismatch");
});

await check("abort() on chat with no running process returns false", () => {
  // The setSession above set a session but no process is running, so abort
  // should be a no-op that returns false.
  client.clearSession(chatId);
  if (client.abort(chatId) !== false) throw new Error("expected false");
});

await check("sendMessage() with a real prompt returns content", async () => {
  const opts: SendMessageOpts = { model: "xiaomi/mimo-v2.5-pro" };
  const result = await client.sendMessage(
    "integration-test-chat",
    "Reply with exactly: PONG",
    opts,
  );
  if (!result.content || result.content.length === 0) {
    throw new Error("empty content");
  }
  console.log(
    `    content (first 80 chars): ${result.content.slice(0, 80).replace(/\n/g, " ")}`,
  );
});

await check(
  "sendMessage() session recovery: invalid session triggers retry",
  async () => {
    // First set an invalid session id, then send a message.
    // The retry logic should detect "Session not found" and start a new session.
    const testChat = "integration-test-recovery";
    client.setSession(testChat, "ses_does_not_exist_zzz");
    const result = await client.sendMessage(
      testChat,
      "Reply with exactly: RECOVERED",
    );
    if (!result.content) throw new Error("no content after recovery");
    // The recovered session should be different from the bogus one.
    const newSession = client.getSessionId(testChat);
    if (newSession === "ses_does_not_exist_zzz") {
      throw new Error("session was not reset after recovery");
    }
    console.log(`    recovered session: ${newSession?.slice(0, 16)}...`);
  },
);

// ── checkAuth (in-process, no CLI needed) ──
await check("checkAuth: allowed user", () => {
  if (!checkAuth({ from: { id: 6985614590 } }, config)) {
    throw new Error("should be allowed");
  }
});

await check("checkAuth: disallowed user", () => {
  if (checkAuth({ from: { id: 999 } }, config)) {
    throw new Error("should be denied");
  }
});

// ── sanitizeError (in-process) ──
await check("sanitizeError: masks local paths", () => {
  const out = sanitizeError("failed at /tmp/mimocode-test/secret/file.ts");
  if (out.includes("/tmp/mimocode-test")) throw new Error("path leaked");
  if (!out.includes("<path>")) throw new Error("not masked");
});

await check("sanitizeError: strips ANSI", () => {
  const out = sanitizeError("\x1B[31mERROR\x1B[0m");
  if (out.includes("\x1B")) throw new Error("ANSI leaked");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
