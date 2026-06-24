import { Bot, type Context, InlineKeyboard, InputFile } from "grammy";
import { isAllowed, type Config, type Verbosity } from "./config.js";
import {
  formatLong,
  parseJsonSafe,
  stripSystemTags,
  wrapCode,
} from "./format.js";
import { MimoClient, type SendMessageOpts } from "./mimo.js";

export function checkAuth(
  ctx: { from?: { id: number } },
  config: Config,
): boolean {
  if (!ctx.from) return false;
  return isAllowed(String(ctx.from.id), config);
}

export function sanitizeError(raw: string): string {
  let clean = raw
    .replace(/\/[\w./-]+/g, "<path>")
    .replace(/[A-Z]:\\[\w\\.-]+/gi, "<path>");
  clean = clean.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  if (clean.length > 100) clean = `${clean.slice(0, 100)}...`;
  return clean || "Unknown error";
}

const eventVerbosityKey: Record<string, keyof Config> = {
  text: "showText",
  reasoning: "showReasoning",
  tool_use: "showToolUse",
  step_start: "showStepStart",
  step_finish: "showStepFinish",
};

function getVerbosity(evType: string, cfg: Config): Verbosity {
  const key = eventVerbosityKey[evType];
  if (!key) return "off";
  return cfg[key] as Verbosity;
}

function hintIcon(evType: string): string {
  switch (evType) {
    case "reasoning": return "💭";
    case "tool_use": return "🔧";
    case "step_start": return "⟳";
    case "step_finish": return "✓";
    default: return "⏳";
  }
}

function formatEventHint(event: Record<string, unknown>): string {
  const type = event.type as string;
  const part = event.part as Record<string, unknown> | undefined;
  switch (type) {
    case "reasoning":
      return "💭 正在思考...";
    case "tool_use": {
      const tool = part?.tool as string ?? "";
      const state = part?.state as Record<string, unknown> | undefined;
      const title = state?.title as string ?? "";
      const inp = state?.input as Record<string, unknown> | undefined;
      const cmd = inp?.command as string ?? inp?.description as string ?? "";
      return `🔧 ${tool}: ${(title || cmd).slice(0, 80)}`;
    }
    case "step_start":
      return "⟳ 正在处理...";
    case "step_finish": {
      const tokens = part?.tokens as Record<string, number> | undefined;
      const reason = part?.reason as string ?? "";
      const cost = part?.cost as number | undefined;
      let extra = "";
      if (tokens) extra += ` ${tokens.total ?? 0}t`;
      if (cost != null) extra += ` $${cost.toFixed(4)}`;
      return `✓ 步骤完成 (${reason}${extra})`;
    }
    default:
      return "⏳ 处理中...";
  }
}

function formatEventBrief(event: Record<string, unknown>): string {
  const type = event.type as string;
  const part = event.part as Record<string, unknown> | undefined;
  switch (type) {
    case "reasoning": {
      const text = (part?.text as string) ?? "";
      const firstLine = text.split("\n")[0] ?? "";
      return `💭 ${firstLine.slice(0, 200)}`;
    }
    case "tool_use": {
      const tool = part?.tool as string ?? "";
      const state = part?.state as Record<string, unknown> | undefined;
      const title = state?.title as string ?? "";
      const inp = state?.input as Record<string, unknown> | undefined;
      const cmd = inp?.command as string ?? inp?.description as string ?? "";
      return `🔧 ${tool}: ${(title || cmd).slice(0, 200)}`;
    }
    case "step_start":
      return "⟳ step start";
    case "step_finish": {
      const tokens = part?.tokens as Record<string, number> | undefined;
      const reason = part?.reason as string ?? "";
      if (tokens) return `✓ step finish (${reason}, ${tokens.total ?? 0} tokens)`;
      return `✓ step finish (${reason})`;
    }
    default:
      return `${type}`;
  }
}

function formatEventFull(event: Record<string, unknown>): string {
  const type = event.type as string;
  const part = event.part as Record<string, unknown> | undefined;
  switch (type) {
    case "reasoning": {
      const text = (part?.text as string) ?? "";
      return `💭 思考:\n${text}`;
    }
    case "tool_use": {
      const tool = part?.tool as string ?? "";
      const state = part?.state as Record<string, unknown> | undefined;
      const inp = state?.input as Record<string, unknown> | undefined;
      const output = (state?.output as string) ?? "";
      const lines = [`🔧 ${tool}`];
      const cmd = inp?.command as string | undefined;
      const desc = inp?.description as string | undefined;
      if (cmd) lines.push(`  command: ${cmd}`);
      if (desc && desc !== cmd) lines.push(`  description: ${desc}`);
      if (output) lines.push(`  output: ${output.slice(0, 500)}`);
      return lines.join("\n");
    }
    case "step_start":
      return "⟳ step start";
    case "step_finish": {
      const tokens = part?.tokens as Record<string, number> | undefined;
      const reason = part?.reason as string ?? "";
      const cost = part?.cost as number | undefined;
      if (tokens) {
        return `✓ step finish\n  reason: ${reason}\n  tokens: ${tokens.total ?? 0} (in:${tokens.input ?? 0} out:${tokens.output ?? 0})${cost != null ? ` cost:$${cost.toFixed(6)}` : ""}`;
      }
      return `✓ step finish (${reason})`;
    }
    default:
      return `${type}: ${JSON.stringify(event).slice(0, 500)}`;
  }
}

export function createBot(config: Config) {
  const bot = new Bot(config.telegramToken);
  const mimo = new MimoClient(config);
  const processing = new Set<string>();
  const lastSessions = new Map<
    string,
    { sessions: Array<{ id: string; title: string }>; ts: number }
  >();

  async function sendLong(chatId: string, text: string) {
    const chunks = formatLong(text);
    for (const chunk of chunks) {
      try {
        await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
      } catch {
        await bot.api.sendMessage(chatId, chunk.replace(/<[^>]+>/g, ""));
      }
    }
  }

  type MimoRunOpts = {
    logPrefix: string;
    mimoOpts?: SendMessageOpts;
  };

  async function runMimoCommand(ctx: Context, text: string, opts: MimoRunOpts) {
    const chatId = String(ctx.chat?.id);
    if (processing.has(chatId)) {
      await ctx.reply("Task running. Wait or /cancel.");
      return;
    }
    processing.add(chatId);
    const startTime = Date.now();

    // Keep the "typing…" indicator alive while mimo is working.
    // Telegram expires the status after ~5 seconds, so refresh every 4s.
    const typingInterval = setInterval(() => {
      bot.api.sendChatAction(chatId, "typing").catch(() => {});
    }, 4000);
    bot.api.sendChatAction(chatId, "typing").catch(() => {});

    try {

      const onEvent = (event: Record<string, unknown>) => {
        const evType = event.type as string | undefined;
        if (!evType) return;
        const v = getVerbosity(evType, config);
        if (v === "off") return;
        if (evType === "text") {
          if (v === "brief") {
            const part = event.part as { text?: string } | undefined;
            const firstLine = (part?.text ?? "").split("\n")[0] ?? "";
            if (firstLine) {
              bot.api.sendMessage(chatId, firstLine.slice(0, 500)).catch(() => {});
            }
          } else if (v === "hint") {
            bot.api.sendMessage(chatId, hintIcon(evType) + " 回复中...").catch(() => {});
          }
          return;
        }
        if (v === "hint") {
          bot.api.sendMessage(chatId, formatEventHint(event)).catch(() => {});
        } else if (v === "brief") {
          bot.api.sendMessage(chatId, formatEventBrief(event)).catch(() => {});
        } else if (v === "full") {
          bot.api.sendMessage(chatId, formatEventFull(event)).catch(() => {});
        }
      };

      const mergedOpts: SendMessageOpts = {
        ...opts.mimoOpts,
        onEvent,
      };
      const result = await mimo.sendMessage(chatId, text, mergedOpts);

      if (!result.content || config.showText === "off") {
        return;
      }
      if (config.showText === "full") {
        await sendLong(chatId, stripSystemTags(result.content));
      } else if (config.showText === "brief") {
        const firstLine = result.content.split("\n")[0] ?? result.content;
        await bot.api.sendMessage(chatId, firstLine.slice(0, 500))
          .catch(() => {});
      } else if (config.showText === "hint") {
        await bot.api.sendMessage(chatId, "✓ 已回复").catch(() => {});
      }
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
      clearInterval(typingInterval);
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

    await runMimoCommand(ctx, text, { logPrefix: "chat" });
  });

  bot.catch((err) => {
    console.error("Bot error:", err);
  });

  return bot;
}
