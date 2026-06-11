import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { Config } from "./config.js";
import { MimoClient } from "./mimo.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
  return `<pre><code>${escapeHtml(text)}</code></pre>`;
}

function formatLong(text: string): string[] {
  const html = markdownToTelegramHtml(text);
  if (html.length <= 4096) return [html];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, 4000);
    remaining = remaining.slice(4000);
    chunks.push(markdownToTelegramHtml(chunk));
  }
  return chunks;
}

export function createBot(config: Config) {
  const bot = new Bot(config.telegramToken);
  const mimo = new MimoClient(config);
  const processing = new Set<string>();

  // ── /start ───────────────────────────────────────────
  bot.command("start", async (ctx) => {
    if (!ctx.from) return;
    const userId = String(ctx.from.id);
    if (!isAllowed(userId, config)) {
      await ctx.reply("Access denied.");
      return;
    }
    const version = await mimo.getVersion();
    const kb = new InlineKeyboard()
      .text("Status", "/status")
      .text("Sessions", "/sessions")
      .row()
      .text("Models", "/models")
      .text("Stats", "/stats")
      .row()
      .text("New Session", "/new");

    await ctx.reply(
      `<b>MiMoCode Bot</b> v${version}\n\n` +
        `Send any message to chat with your MiMoCode agent.\n\n` +
        `<b>Commands</b>\n` +
        `/new — Start a new session\n` +
        `/cancel — Cancel running task\n` +
        `/status — Connection & session info\n` +
        `/sessions — List all sessions\n` +
        `/models — List available models\n` +
        `/stats — Usage statistics\n` +
        `/export — Export current session\n` +
        `/providers — List AI providers\n` +
        `/agent — Show current agent\n` +
        `/delete &lt;id&gt; — Delete a session\n` +
        `/version — MimoCode version`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  // ── /version ─────────────────────────────────────────
  bot.command("version", async (ctx) => {
    if (!ctx.from) return;
    if (!isAllowed(String(ctx.from.id), config)) return;
    const v = await mimo.getVersion();
    await ctx.reply(`MiMoCode v${v}`);
  });

  // ── /new ─────────────────────────────────────────────
  bot.command("new", async (ctx) => {
    if (!ctx.from) return;
    if (!isAllowed(String(ctx.from.id), config)) return;
    const chatId = String(ctx.chat.id);

    const oldSession = mimo.getSessionId(chatId);
    if (oldSession) {
      await mimo.exec(["session", "delete", oldSession]);
    }
    mimo.clearSession(chatId);
    await ctx.reply("Session cleared. Send a new message to start fresh.");
  });

  // ── /status ──────────────────────────────────────────
  bot.command("status", async (ctx) => {
    if (!ctx.from) return;
    if (!isAllowed(String(ctx.from.id), config)) return;
    const chatId = String(ctx.chat.id);

    const [version, sessionList] = await Promise.all([
      mimo.getVersion(),
      mimo.exec(["session", "list", "--format", "json"]),
    ]);

    const sessions = JSON.parse(sessionList.stdout || "[]") as Array<{
      id: string;
      title: string;
      updated: number;
    }>;

    const currentSession = mimo.getSessionId(chatId);
    const current = sessions.find((s) => s.id === currentSession);

    const lines = [
      `<b>MiMoCode Status</b>`,
      ``,
      `Version: ${version}`,
      `CLI: OK`,
      `Total sessions: ${sessions.length}`,
      ``,
    ];

    if (current) {
      const ago = Date.now() - current.updated;
      const mins = Math.floor(ago / 60000);
      lines.push(
        `Current session: <code>${current.id.slice(0, 16)}...</code>`,
        `Title: ${current.title}`,
        `Last active: ${mins < 1 ? "just now" : `${mins}m ago`}`,
      );
    } else {
      lines.push(`No active session for this chat.`);
    }

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // ── /sessions ────────────────────────────────────────
  bot.command("sessions", async (ctx) => {
    if (!ctx.from) return;
    if (!isAllowed(String(ctx.from.id), config)) return;

    const r = await mimo.exec(["session", "list", "--format", "json"]);
    const sessions = JSON.parse(r.stdout || "[]") as Array<{
      id: string;
      title: string;
      updated: number;
      created: number;
    }>;

    if (sessions.length === 0) {
      await ctx.reply("No sessions found.");
      return;
    }

    const currentSession = mimo.getSessionId(String(ctx.chat.id));
    const lines = [`<b>Sessions</b> (${sessions.length})\n`];

    for (const s of sessions.slice(0, 20)) {
      const isCurrent = s.id === currentSession;
      const marker = isCurrent ? " *" : "";
      const ago = Date.now() - s.updated;
      const timeStr =
        ago < 60000
          ? "just now"
          : ago < 3600000
            ? `${Math.floor(ago / 60000)}m ago`
            : ago < 86400000
              ? `${Math.floor(ago / 3600000)}h ago`
              : `${Math.floor(ago / 86400000)}d ago`;
      lines.push(
        `<code>${s.id.slice(0, 20)}</code>${marker}`,
        `  ${s.title} (${timeStr})`,
        ``,
      );
    }

    if (sessions.length > 20) {
      lines.push(`... and ${sessions.length - 20} more`);
    }

    lines.push(`* = current session`);

    const chunks = formatLong(lines.join("\n"));
    for (const chunk of chunks) {
      await ctx.api.sendMessage(ctx.chat.id, chunk, { parse_mode: "HTML" }).catch(() =>
        ctx.api.sendMessage(ctx.chat.id, chunk),
      );
    }
  });

  // ── /models ──────────────────────────────────────────
  bot.command("models", async (ctx) => {
    if (!ctx.from) return;
    if (!isAllowed(String(ctx.from.id), config)) return;

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
      `<b>Available Models</b> (${models.length})\n`,
      models.map((m) => `• <code>${m}</code>`).join("\n"),
    ];

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  // ── /stats ───────────────────────────────────────────
  bot.command("stats", async (ctx) => {
    if (!ctx.from) return;
    if (!isAllowed(String(ctx.from.id), config)) return;

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
    if (!ctx.from) return;
    if (!isAllowed(String(ctx.from.id), config)) return;
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

    // Send as file
    const data = Buffer.from(r.stdout, "utf-8");
    const file = new InputFile(data, `session-${sessionId.slice(0, 16)}.json`);
    await ctx.replyWithDocument(file).catch(async () => {
      // Fallback: send as text
      await ctx.reply(r.stdout.slice(0, 4000));
    });
  });

  // ── /providers ───────────────────────────────────────
  bot.command("providers", async (ctx) => {
    if (!ctx.from) return;
    if (!isAllowed(String(ctx.from.id), config)) return;

    const r = await mimo.exec(["providers", "list"], { timeoutMs: 10_000 });
    const output = r.stdout.trim();
    if (!output) {
      await ctx.reply("No providers configured.");
      return;
    }
    await ctx.reply(wrapCode(output), { parse_mode: "HTML" });
  });

  // ── /agent ───────────────────────────────────────────
  bot.command("agent", async (ctx) => {
    if (!ctx.from) return;
    if (!isAllowed(String(ctx.from.id), config)) return;

    const r = await mimo.exec(["agent", "list"], { timeoutMs: 10_000 });
    const output = r.stdout.trim();
    if (!output) {
      await ctx.reply("No agents found.");
      return;
    }
    await ctx.reply(wrapCode(output), { parse_mode: "HTML" });
  });

  // ── /delete <id> ─────────────────────────────────────
  bot.command("delete", async (ctx) => {
    if (!ctx.from) return;
    if (!isAllowed(String(ctx.from.id), config)) return;

    const sessionId = ctx.match;
    if (!sessionId) {
      await ctx.reply("Usage: /delete <session_id>");
      return;
    }

    const r = await mimo.exec(["session", "delete", sessionId]);
    if (r.code === 0) {
      mimo.clearSession(String(ctx.chat.id));
      await ctx.reply(`Session ${sessionId.slice(0, 16)}... deleted.`);
    } else {
      await ctx.reply(`Delete failed: ${r.stderr.slice(0, 200)}`);
    }
  });

  // ── /cancel ──────────────────────────────────────────
  bot.command("cancel", async (ctx) => {
    if (!ctx.from) return;
    if (!isAllowed(String(ctx.from.id), config)) return;
    const chatId = String(ctx.chat.id);
    if (processing.has(chatId)) {
      processing.delete(chatId);
      await ctx.reply("Task cancelled.");
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
    console.log(`[${new Date().toISOString()}] Received: chat=${chatId} user=${userId} text=${text.slice(0, 50)}`);

    if (!isAllowed(userId, config)) {
      await ctx.reply("Access denied.");
      return;
    }

    if (processing.has(chatId)) {
      await ctx.reply("Previous task still running. Wait or /cancel.");
      return;
    }

    processing.add(chatId);
    const startTime = Date.now();

    try {
      const sent = await ctx.reply("...");
      const result = await mimo.sendMessage(chatId, text, () => {});

      if (!result.content) {
        await bot.api
          .editMessageText(chatId, sent.message_id, "(empty response)")
          .catch(() => {});
        return;
      }

      const html = markdownToTelegramHtml(result.content);

      try {
        if (html.length <= 4096) {
          await bot.api.editMessageText(chatId, sent.message_id, html, {
            parse_mode: "HTML",
          });
        } else {
          const firstChunk = html.slice(0, 4096);
          await bot.api.editMessageText(chatId, sent.message_id, firstChunk, {
            parse_mode: "HTML",
          });
          let remaining = html.slice(4096);
          while (remaining.length > 0) {
            const chunk = remaining.slice(0, 4096);
            remaining = remaining.slice(4096);
            await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
          }
        }
      } catch {
        await bot.api
          .editMessageText(
            chatId,
            sent.message_id,
            result.content.slice(0, 4096),
          )
          .catch(() => {});
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(
        `[${new Date().toISOString()}] chat=${chatId} user=${userId} len=${result.content.length} time=${elapsed}s`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${new Date().toISOString()}] Error: ${msg}`);
      try {
        await ctx.reply(`Error: ${msg}`);
      } catch {
        // ignore
      }
    } finally {
      processing.delete(chatId);
    }
  });

  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  return bot;
}

function isAllowed(userId: string, config: Config): boolean {
  if (config.allowedUserIds.length === 0) return true;
  return config.allowedUserIds.includes(userId);
}
