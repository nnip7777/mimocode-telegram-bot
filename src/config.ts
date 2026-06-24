import { resolve } from "node:path";

export function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env: ${key}`);
  return val;
}

export function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw === "true" || raw === "1";
}

export type Verbosity = "full" | "brief" | "hint" | "off";

export function envVerbosity(key: string, fallback: Verbosity): Verbosity {
  const raw = process.env[key];
  if (!raw) return fallback;
  const valid = ["full", "brief", "hint", "off"] as const;
  if ((valid as readonly string[]).includes(raw)) return raw as Verbosity;
  console.warn(
    `${key}=${raw} is invalid; using ${fallback}. Valid: ${valid.join(", ")}`,
  );
  return fallback;
}

export type Config = {
  readonly telegramToken: string;
  readonly allowedUserIds: readonly string[];
  readonly mimoWorkDir: string;
  readonly mimoApiUrl?: string;
  readonly skipPermissions: boolean;
  readonly showText: Verbosity;
  readonly showReasoning: Verbosity;
  readonly showToolUse: Verbosity;
  readonly showStepStart: Verbosity;
  readonly showStepFinish: Verbosity;
};

export function loadConfig(): Config {
  const allowedRaw = env("TELEGRAM_ALLOWED_USER_ID", "");
  const allowedUserIds = allowedRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowedUserIds.length === 0) {
    throw new Error(
      "TELEGRAM_ALLOWED_USER_ID is empty. Refusing to start: an empty whitelist would let anyone drive your local agent. Set at least one Telegram numeric user ID (get yours from @userinfobot).",
    );
  }

  return {
    telegramToken: env("TELEGRAM_BOT_TOKEN"),
    allowedUserIds,
    mimoWorkDir: env("MIMO_WORK_DIR", resolve(process.cwd())),
    mimoApiUrl: process.env.MIMO_API_URL || undefined,
    skipPermissions: envBool("MIMO_SKIP_PERMISSIONS", false),
    showText: envVerbosity("MIMO_SHOW_TEXT", "full"),
    showReasoning: envVerbosity("MIMO_SHOW_REASONING", "off"),
    showToolUse: envVerbosity("MIMO_SHOW_TOOL_USE", "off"),
    showStepStart: envVerbosity("MIMO_SHOW_STEP_START", "off"),
    showStepFinish: envVerbosity("MIMO_SHOW_STEP_FINISH", "off"),
  };
}

export function isAllowed(userId: string, config: Config): boolean {
  return config.allowedUserIds.includes(userId);
}
