import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { Config } from "./config.js";
import { isAllowed } from "./config.js";
import { MimoClient } from "./mimo.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\[[\?]?[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\u2500-\u257F]/g, "")
    .replace(/[\u2580-\u259F]/g, "")
    .replace(/[\u25A0-\u25FF]/g, "");
}

function stripSystemTags(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

function markdownToTelegramHtml(text: string): string {
  if (!text) return "";

  const codeBlocks: string[] = [];
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code: string) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_, code: string) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  text = text.replace(/^#{1,6}\s+(.+)$/gm, "\x00B\x00$1\x00/B\x00");
  text = text.replace(/^>\s*(.*)$/gm, "$1");
  text = escapeHtml(text);

  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");
  text = text.replace(
    /(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g,
    "<i>$1</i>",
  );
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");
  text = text.replace(/^[-*]\s+/gm, "• ");
  text = text.replace(/^(\d+)\.\s+/gm, "$1. ");

  for (let i = 0; i < inlineCodes.length; i++) {
    text = text.replace(
      `\x00IC${i}\x00`,
      `<code>${escapeHtml(inlineCodes[i] ?? "")}</code>`,
    );
  }

  for (let i = 0; i < codeBlocks.length; i++) {
    text = text.replace(
      `\x00CB${i}\x00`,
      `<pre><code>${escapeHtml(codeBlocks[i] ?? "")}</code></pre>`,
    );
  }

  text = text.replace(/\x00B\x00/g, "<b>").replace(/\x00\/B\x00/g, "</b>");

  return text;
}

function wrapCode(text: string): string {
  return `<pre><code>${escapeHtml(stripAnsi(text))}</code></pre>`;
}

function formatLong(text: string): string[] {
  const BUDGET = 3500;

  if (text.length <= BUDGET) {
    return [markdownToTelegramHtml(text)];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= BUDGET) {
      chunks.push(markdownToTelegramHtml(remaining));
      break;
    }

    let cutAt = remaining.lastIndexOf("\n", BUDGET);
    if (cutAt <= 0) {
      cutAt = remaining.lastIndexOf(" ", BUDGET);
    }
    if (cutAt <= 0) {
      cutAt = BUDGET;
    }

    chunks.push(markdownToTelegramHtml(remaining.slice(0, cutAt)));
    remaining = remaining.slice(cutAt);
  }

  return chunks;
}

function parseJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function checkAuth(ctx: { from?: { id: number } }, config: Config): boolean {
  if (!ctx.from) return false;
  return isAllowed(String(ctx.from.id), config);
}

export function createBot(config: Config) {
  const bot = new Bot(config.telegramToken);
  const mimo = new MimoClient(config);
  const processing = new Set<string>();
  const lastSessions = new Map<string, Array<{ id: string; title: string }>>();

  async function sendResult(chatId: string, msgId: number, content: string) {
    const cleaned = stripSystemTags(content);
    const chunks = formatLong(cleaned);
    try {
      await bot.api.editMessageText(chatId, msgId, chunks[0], { parse_mode: "HTML" });
      for (let i = 1; i < chunks.length; i++) {
        await bot.api.sendMessage(chatId, chunks[i], { parse_mode: "HTML" });
      }
    } catch {
      await bot.api.editMessageText(chatId, msgId, cleaned.slice(0, 4096)).catch(() => {});
    }
  }

  async function sendLong(chatId: string, text: string) {
    const chunks = formatLong(text);
    for (const chunk of chunks) {
      await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" }).catch(() =>
        bot.api.sendMessage(chatId, chunk),
      );
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
        await ctx.reply(`Failed to clear old session: ${r.stderr.slice(0, 200)}`);
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

    const sessions = parseJsonSafe<Array<{ id: string; title: string; updated: number }>>(
      sessionList.stdout, [],
    );

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
    const sessions = parseJsonSafe<Array<{
      id: string; title: string; updated: number;
    }>>(r.stdout, []);

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

    lastSessions.set(chatId, sessions.map((s) => ({ id: s.id, title: s.title })));
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
      const models = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
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
    const chatId = String(ctx.chat.id);
    const text = ctx.match?.trim();

    if (!text) {
      await ctx.reply(
        `Usage: /compose &lt;your idea&gt;\n\n` +
          `Runs: plan → code → test → review`,
      );
      return;
    }

    if (processing.has(chatId)) {
      await ctx.reply("Task running. Wait or /cancel.");
      return;
    }

    processing.add(chatId);
    const startTime = Date.now();

    try {
      const sent = await ctx.reply("⏳ Compose: plan → code → test → review...");
      const result = await mimo.sendMessage(chatId, text, { agent: "compose" });

      if (!result.content) {
        await bot.api.editMessageText(chatId, sent.message_id, "(empty)").catch(() => {});
        return;
      }

      await sendResult(chatId, sent.message_id, result.content);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[${new Date().toISOString()}] compose chat=${chatId} time=${elapsed}s`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try { await ctx.reply(`Error: ${msg}`); } catch {}
    } finally {
      processing.delete(chatId);
    }
  });

  // ── /max ────────────────────────────────────────────
  bot.command("max", async (ctx) => {
    if (!checkAuth(ctx, config)) return;
    const chatId = String(ctx.chat.id);
    const text = ctx.match?.trim();

    if (!text) {
      await ctx.reply("Usage: /max &lt;complex task&gt;");
      return;
    }

    if (processing.has(chatId)) {
      await ctx.reply("Task running. Wait or /cancel.");
      return;
    }

    processing.add(chatId);
    const startTime = Date.now();

    try {
      const sent = await ctx.reply("⚡ Max mode...");
      const result = await mimo.sendMessage(chatId, text, { variant: "max" });

      if (!result.content) {
        await bot.api.editMessageText(chatId, sent.message_id, "(empty)").catch(() => {});
        return;
      }

      await sendResult(chatId, sent.message_id, result.content);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[${new Date().toISOString()}] max chat=${chatId} time=${elapsed}s`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try { await ctx.reply(`Error: ${msg}`); } catch {}
    } finally {
      processing.delete(chatId);
    }
  });

  // ── /models ──────────────────────────────────────────
  bot.command("models", async (ctx) => {
    if (!checkAuth(ctx, config)) return;

    const r = await mimo.exec(["models"], { timeoutMs: 10_000 });
    const models = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);

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
      await ctx.reply(`Export failed: ${r.stderr.slice(0, 200)}`);
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
        await ctx.reply(`Delete failed: ${r.stderr.slice(0, 200)}`);
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
      await ctx.reply(`Delete failed: ${r.stderr.slice(0, 200)}`);
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
      const sessions = lastSessions.get(chatId);
      if (sessions && num <= sessions.length) {
        const target = sessions[num - 1];
        mimo.setSession(chatId, target.id);
        await ctx.reply(`Switched to session:\n<code>${target.id}</code>\n${target.title}`, { parse_mode: "HTML" });
        lastSessions.delete(chatId);
        return;
      }
    }

    if (processing.has(chatId)) {
      await ctx.reply("Task running. Wait or /cancel.");
      return;
    }

    processing.add(chatId);
    const startTime = Date.now();

    try {
      const sent = await ctx.reply("...");
      const result = await mimo.sendMessage(chatId, text);

      if (!result.content) {
        await bot.api.editMessageText(chatId, sent.message_id, "(empty)").catch(() => {});
        return;
      }

      await sendResult(chatId, sent.message_id, result.content);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[${new Date().toISOString()}] chat=${chatId} user=${userId} time=${elapsed}s`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${new Date().toISOString()}] Error: ${msg}`);
      try { await ctx.reply(`Error: ${msg}`); } catch {}
    } finally {
      processing.delete(chatId);
    }
  });

  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  return bot;
}
