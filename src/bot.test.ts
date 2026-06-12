import { describe, expect, it } from "bun:test";
import { checkAuth, sanitizeError } from "./bot.js";
import type { Config } from "./config.js";

// ── checkAuth ─────────────────────────────────────────

const baseConfig: Config = {
  telegramToken: "test-token",
  allowedUserIds: ["111", "222"],
  mimoWorkDir: "/tmp",
  skipPermissions: false,
  runTimeoutMs: 120_000,
};

describe("checkAuth", () => {
  it("returns true for allowed user", () => {
    const ctx = { from: { id: 111 } };
    expect(checkAuth(ctx, baseConfig)).toBe(true);
  });

  it("returns false for disallowed user", () => {
    const ctx = { from: { id: 999 } };
    expect(checkAuth(ctx, baseConfig)).toBe(false);
  });

  it("returns false when ctx.from is undefined", () => {
    const ctx = {};
    expect(checkAuth(ctx, baseConfig)).toBe(false);
  });
});

// ── sanitizeError ─────────────────────────────────────

describe("sanitizeError", () => {
  it("masks Unix-style paths", () => {
    const result = sanitizeError("error in /home/user/project/file.ts");
    expect(result).toContain("<path>");
    expect(result).not.toContain("/home/user");
  });

  it("masks Windows-style paths", () => {
    const result = sanitizeError("error in C:\\Users\\test\\file.ts");
    expect(result).toContain("<path>");
    expect(result).not.toContain("C:\\Users");
  });

  it("strips ANSI escape codes", () => {
    const result = sanitizeError("\x1B[31msome error\x1B[0m");
    expect(result).not.toContain("\x1B");
    expect(result).toContain("some error");
  });

  it("truncates long errors to 100 chars", () => {
    const longError = "x".repeat(200);
    const result = sanitizeError(longError);
    expect(result.length).toBeLessThanOrEqual(110); // 100 + "..."
    expect(result).toContain("...");
  });

  it('returns "Unknown error" for empty input', () => {
    expect(sanitizeError("")).toBe("Unknown error");
  });

  it("preserves short messages", () => {
    expect(sanitizeError("connection refused")).toBe("connection refused");
  });
});
