import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { Config } from "./config.js";
import { isAllowed } from "./config.js";
import {
  formatLong,
  parseJsonSafe,
  stripSystemTags,
  wrapCode,
} from "./format.js";
import { MimoClient } from "./mimo.js";

function checkAuth(ctx: { from?: { id: number } }, config: Config): boolean {
  if (!ctx.from) return false;
  return isAllowed(String(ctx.from.id), config);
}

function sanitizeError(raw: string): string {
  let clean = raw
    .replace(/\/[\w./-]+/g, "<path>")
    .replace(/[A-Z]:\\[\w\\.-]+/gi, "<path>");
  clean = clean.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  if (clean.length > 100) clean = `${clean.slice(0, 100)}...`;
  return clean || "Unknown error";
}

export function createBot(config: Config) {
  const bot = new Bot(config.telegramToken);
  const mimo = new MimoClient(config);
  const processing = new Set<string>();
  const lastSessions = new Map<
    string,
    { sessions: Array<{ id: string; title: string }>; ts: number }
  >();

  async function sendResult(chatId: string, msgId: number, content: string) {
    const cleaned = stripSystemTags(content);
    const chunks = formatLong(cleaned);
    try {
      await bot.api.editMessageText(chatId, msgId, chunks[0], {
        parse_mode: "HTML",
      });
      for (let i = 1; i < chunks.length; i++) {
        await bot.api.sendMessage(chatId, chunks[i], { parse_mode: "HTML" });
      }
    } catch {
      await bot.api
        .editMessageText(chatId, msgId, cleaned.slice(0, 4096))
        .catch(() => {});
    }
  }

  async function sendLong(chatId: string, text: string) {
    const chunks = formatLong(text);
    for (const chunk of chunks) {
      await bot.api
        .sendMessage(chatId, chunk, { parse_mode: "HTML" })
        .catch(() => bot.api.sendMessage(chatId, chunk));
    }
  }

  type MimoRunOpts = {
    placeholder: string;
    logPrefix: string;
    mimoOpts?: import("./mimo.js").SendMessageOpts;
  };

  async function runMimoCommand(
    ctx: import("grammy").Context,
    text: string,
    opts: MimoRunOpts,
  ) {
    const chatId = String(ctx.chat?.id);
    if (processing.has(chatId)) {
      await ctx.reply("Task running. Wait or /cancel.");
      return;
    }
    processing.add(chatId);
    const startTime = Date.now();
    try {
      const sent = await ctx.reply(opts.placeholder);
      const result = await mimo.sendMessage(chatId, text, opts.mimoOpts);
      if (!result.content) {
        await bot.api
          .editMessageText(chatId, sent.message_id, "(empty)")
          .catch(() => {});
        return;
      }
      await sendResult(chatId, sent.message_id, result.content);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `[${new Date().toISOString()}] ${opts.logPrefix} chat=${chatId} time=${elapsed}s`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await ctx.reply(`Error: ${sanitizeError(msg)}`);
      } catch {}
    } finally {
      processing.delete(chatId);
    }
  }

  function mainMenuKb(): InlineKeyboard {
    return new InlineKeyboard()
      .text("Status", "/status")
      .text("Sessions", "/sessions")
      .row()
      .text("Models", "/models")
      .text("Stats", "/stats")
      .row()
      .text("New Session", "/new");
  }

  // ── /start ───────────────────────────────────────────
  bot.command("start", async (ctx) => {
    if (!checkAuth(ctx, config)) {
      await ctx.reply("Access denied.");
      return;
    }
    const version = await mimo.getVersion();

    await ctx.reply(
      `<b>MiMoCode Bot</b> v${version}\n\n` +
        `Send any message to chat with your MiMoCode agent.\n\n` +
        `<b>Quick Actions</b>`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() },
    );
  });

  // ── /help ────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    await ctx.reply(
      `<b>Commands</b>\n\n` +
        `<b>Chat</b>\n` +
        `Send any text to chat with MiMoCode\n\n` +
        `<b>Sessions</b>\n` +
        `/new — Start new session\n` +
        `/cancel — Stop running task\n` +
        `/sessions — List sessions (reply number to switch)\n` +
        `/export — Export session as JSON\n` +
        `/delete — Delete a session\n\n` +
        `<b>Modes</b>\n` +
        `/use — Switch agent (build/plan/compose)\n` +
        `/compose — Compose mode workflow\n` +
        `/max — Max parallel sampling\n\n` +
        `<b>Info</b>\n` +
        `/model — Switch model\n` +
        `/models — List models\n` +
        `/status — Connection info\n` +
        `/stats — Usage stats\n` +
        `/providers — List providers\n` +
        `/version — Version info`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() },
    );
  });

  // ── /version ─────────────────────────────────────────
  bot.command("version", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const v = await mimo.getVersion();
    await ctx.reply(`MiMoCode v${v}`);
  });

  // ── /new ─────────────────────────────────────────────
  bot.command("new", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);

    const oldSession = mimo.getSessionId(chatId);
    if (oldSession) {
      const r = await mimo.exec(["session", "delete", oldSession]);
      if (r.code !== 0) {
        await ctx.reply(
          `Failed to clear old session: ${sanitizeError(r.stderr)}`,
        );
        return;
      }
    }
    mimo.clearSession(chatId);
    await ctx.reply("Session cleared. Send a new message to start fresh.");
  });

  // ── /status ──────────────────────────────────────────
  bot.command("status", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);

    const [version, sessionList] = await Promise.all([
      mimo.getVersion(),
      mimo.exec(["session", "list", "--format", "json"]),
    ]);

    const sessions = parseJsonSafe<
      Array<{ id: string; title: string; updated: number }>
    >(sessionList.stdout, []);

    const currentSession = mimo.getSessionId(chatId);
    const current = sessions.find((s) => s.id === currentSession);
    const model = mimo.getModel(chatId);
    const agent = mimo.getAgent(chatId) ?? "build";

    const lines = [
      `<b>Status</b>`,
      ``,
      `Version: ${version}`,
      `Sessions: ${sessions.length}`,
      `Model: <code>${model ?? "default"}</code>`,
      `Agent: <code>${agent}</code>`,
    ];

    if (current) {
      const ago = Date.now() - current.updated;
      const mins = Math.floor(ago / 60000);
      lines.push(
        ``,
        `Current: <code>${current.id.slice(0, 16)}...</code>`,
        `Title: ${current.title}`,
        `Active: ${mins < 1 ? "just now" : `${mins}m ago`}`,
      );
    } else {
      lines.push(``, `No active session.`);
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // ── /sessions ────────────────────────────────────────
  bot.command("sessions", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);

    const r = await mimo.exec(["session", "list", "--format", "json"]);
    const sessions = parseJsonSafe<
      Array<{
        id: string;
        title: string;
        updated: number;
      }>
    >(r.stdout, []);

    if (sessions.length === 0) {
      await ctx.reply("No sessions found.");
      return;
    }

    const currentSession = mimo.getSessionId(chatId);
    const lines = [`<b>Sessions</b> (${sessions.length})\n`];

    for (let i = 0; i < Math.min(sessions.length, 15); i++) {
      const s = sessions[i];
      const isCurrent = s.id === currentSession;
      const marker = isCurrent ? " *" : "";
      const ago = Date.now() - s.updated;
      const timeStr =
        ago < 60000
          ? "now"
          : ago < 3600000
            ? `${Math.floor(ago / 60000)}m`
            : ago < 86400000
              ? `${Math.floor(ago / 3600000)}h`
              : `${Math.floor(ago / 86400000)}d`;
      lines.push(
        `${i + 1}. <code>${s.id.slice(0, 16)}</code>${marker} ${timeStr}`,
        `   ${s.title}`,
        ``,
      );
    }

    if (sessions.length > 15) {
      lines.push(`... and ${sessions.length - 15} more`);
    }

    lines.push(`Reply a number to switch session`);

    const now = Date.now();
    for (const [key, val] of lastSessions) {
      if (now - val.ts > 5 * 60_000) lastSessions.delete(key);
    }
    lastSessions.set(chatId, {
      sessions: sessions.map((s) => ({ id: s.id, title: s.title })),
      ts: now,
    });
    await sendLong(chatId, lines.join("\n"));
  });

  // ── /model ──────────────────────────────────────────
  bot.command("model", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);
    const target = ctx.match?.trim();

    if (!target) {
      const current = mimo.getModel(chatId);
      const r = await mimo.exec(["models"], { timeoutMs: 10_000 });
      const models = r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const lines = [
        `<b>Model</b>: <code>${current ?? "default"}</code>\n`,
        models.map((m) => `• <code>${m}</code>`).join("\n"),
        `\nUsage: /model &lt;provider/model&gt;`,
      ];
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      return;
    }

    mimo.setModel(chatId, target);
    await ctx.reply(`Model → <code>${target}</code>`, { parse_mode: "HTML" });
  });

  // ── /use ───────────────────────────────────────────
  bot.command("use", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);
    const target = ctx.match?.trim();

    if (!target) {
      const current = mimo.getAgent(chatId) ?? "build";
      const lines = [
        `<b>Agent</b>: <code>${current}</code>\n`,
        `• <code>build</code> — Default execution`,
        `• <code>plan</code> — Read-only analysis`,
        `• <code>compose</code> — Full workflow`,
        `\nUsage: /use &lt;agent&gt;`,
      ];
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      return;
    }

    const validAgents = ["build", "plan", "compose"];
    if (!validAgents.includes(target)) {
      await ctx.reply(`Choose from: ${validAgents.join(", ")}`);
      return;
    }

    mimo.setAgent(chatId, target);
    await ctx.reply(`Agent → <code>${target}</code>`, { parse_mode: "HTML" });
  });

  // ── /compose ─────────────────────────────────────────
  bot.command("compose", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const text = ctx.match?.trim();
    if (!text) {
      await ctx.reply(
        `Usage: /compose &lt;your idea&gt;\n\n` +
          `Runs: plan → code → test → review`,
      );
      return;
    }
    await runMimoCommand(ctx, text, {
      placeholder: "⏳ Compose: plan → code → test → review...",
      logPrefix: "compose",
      mimoOpts: { agent: "compose" },
    });
  });

  // ── /max ────────────────────────────────────────────
  bot.command("max", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const text = ctx.match?.trim();
    if (!text) {
      await ctx.reply("Usage: /max &lt;complex task&gt;");
      return;
    }
    await runMimoCommand(ctx, text, {
      placeholder: "⚡ Max mode...",
      logPrefix: "max",
      mimoOpts: { variant: "max" },
    });
  });

  // ── /models ──────────────────────────────────────────
  bot.command("models", async (ctx) => {
    if (!checkAuth(ctx, config)) return;

    const r = await mimo.exec(["models"], { timeoutMs: 10_000 });
    const models = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (models.length === 0) {
      await ctx.reply("No models found.");
      return;
    }

    const lines = [
      `<b>Models</b> (${models.length})\n`,
      models.map((m) => `• <code>${m}</code>`).join("\n"),
    ];

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // ── /stats ───────────────────────────────────────────
  bot.command("stats", async (ctx) => {
    if (!checkAuth(ctx, config)) return;

    const r = await mimo.exec(["stats"], { timeoutMs: 10_000 });
    const output = r.stdout.trim();
    if (!output) {
      await ctx.reply("No stats available.");
      return;
    }
    await ctx.reply(wrapCode(output), { parse_mode: "HTML" });
  });

  // ── /export ──────────────────────────────────────────
  bot.command("export", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);

    const sessionId = mimo.getSessionId(chatId);
    if (!sessionId) {
      await ctx.reply("No active session to export.");
      return;
    }

    const r = await mimo.exec(["export", sessionId], { timeoutMs: 15_000 });
    if (r.code !== 0) {
      await ctx.reply(`Export failed: ${sanitizeError(r.stderr)}`);
      return;
    }

    const data = Buffer.from(r.stdout, "utf-8");
    const file = new InputFile(data, `session-${sessionId.slice(0, 16)}.json`);
    await ctx.replyWithDocument(file).catch(async () => {
      await ctx.reply(r.stdout.slice(0, 4000));
    });
  });

  // ── /providers ───────────────────────────────────────
  bot.command("providers", async (ctx) => {
    if (!checkAuth(ctx, config)) return;

    const r = await mimo.exec(["providers", "list"], { timeoutMs: 10_000 });
    const output = r.stdout.trim();
    if (!output) {
      await ctx.reply("No providers configured.");
      return;
    }
    await ctx.reply(wrapCode(output), { parse_mode: "HTML" });
  });

  // ── /delete ──────────────────────────────────────────
  bot.command("delete", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);

    const sessionId = ctx.match?.trim();
    if (!sessionId) {
      const current = mimo.getSessionId(chatId);
      if (!current) {
        await ctx.reply("No active session to delete.");
        return;
      }
      const r = await mimo.exec(["session", "delete", current]);
      if (r.code === 0) {
        mimo.clearSession(chatId);
        await ctx.reply("Session deleted.");
      } else {
        await ctx.reply(`Delete failed: ${sanitizeError(r.stderr)}`);
      }
      return;
    }

    const r = await mimo.exec(["session", "delete", sessionId]);
    if (r.code === 0) {
      if (mimo.getSessionId(chatId) === sessionId) {
        mimo.clearSession(chatId);
      }
      await ctx.reply("Session deleted.");
    } else {
      await ctx.reply(`Delete failed: ${sanitizeError(r.stderr)}`);
    }
  });

  // ── /cancel, /stop ──────────────────────────────────
  bot.command(["cancel", "stop"], async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);
    if (mimo.abort(chatId)) {
      processing.delete(chatId);
      await ctx.reply("Task cancelled.");
    } else if (processing.has(chatId)) {
      processing.delete(chatId);
      await ctx.reply("Task cancelled (process already finished).");
    } else {
      await ctx.reply("No task running.");
    }
  });

  // ── Text messages → mimo run ─────────────────────────
  bot.on("message:text", async (ctx) => {
    if (!ctx.from) return;
    const userId = String(ctx.from.id);
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text;

    if (!isAllowed(userId, config)) {
      await ctx.reply("Access denied.");
      return;
    }

    const num = Number.parseInt(text, 10);
    if (num >= 1 && text === String(num)) {
      const entry = lastSessions.get(chatId);
      if (entry && num <= entry.sessions.length) {
        const target = entry.sessions[num - 1];
        mimo.setSession(chatId, target.id);
        await ctx.reply(
          `Switched to session:\n<code>${target.id}</code>\n${target.title}`,
          { parse_mode: "HTML" },
        );
        lastSessions.delete(chatId);
        return;
      }
    }

    await runMimoCommand(ctx, text, { placeholder: "...", logPrefix: "chat" });
  });

  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  return bot;
}
