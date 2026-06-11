import { resolve } from "node:path";

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env: ${key}`);
  return val;
}

export type Config = {
  readonly telegramToken: string;
  readonly allowedUserIds: readonly string[];
  readonly mimoWorkDir: string;
  readonly mimoApiUrl?: string;
  readonly skipPermissions: boolean;
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
    mimoApiUrl: process.env.MIMO_API_URL || undefined,
    skipPermissions: process.env.MIMO_SKIP_PERMISSIONS === "true",
  };
}

export function isAllowed(userId: string, config: Config): boolean {
  if (config.allowedUserIds.length === 0) return true;
  return config.allowedUserIds.includes(userId);
}
