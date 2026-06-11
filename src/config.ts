import { resolve } from "node:path";

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env: ${key}`);
  return val;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  return raw ? Number.parseInt(raw, 10) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw === "true" || raw === "1";
}

export type Config = {
  readonly telegramToken: string;
  readonly allowedUserIds: readonly string[];
  readonly mimoWorkDir: string;
  readonly sessionTimeoutMs: number;
  readonly streamEditIntervalMs: number;
  readonly maxMessageLen: number;
};

export function loadConfig(): Config {
  const allowedRaw = env("TELEGRAM_ALLOWED_USER_ID", "");
  const allowedUserIds = allowedRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    telegramToken: env("TELEGRAM_BOT_TOKEN"),
    allowedUserIds,
    mimoWorkDir: env("MIMO_WORK_DIR", resolve(process.cwd())),
    sessionTimeoutMs: envInt("SESSION_TIMEOUT_MS", 30 * 60 * 1000),
    streamEditIntervalMs: envInt("STREAM_EDIT_INTERVAL_MS", 600),
    maxMessageLen: envInt("MAX_MESSAGE_LEN", 4000),
  };
}

export function isAllowed(userId: string, config: Config): boolean {
  if (config.allowedUserIds.length === 0) return true;
  return config.allowedUserIds.includes(userId);
}
