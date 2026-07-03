import { describe, expect, it } from "bun:test";
import type { Config } from "./config.js";
import { MimoClient } from "./mimo.js";

const baseConfig: Config = {
  telegramToken: "test-token",
  allowedUserIds: ["111"],
  mimoWorkDir: "/tmp",
  workdirRoot: "/tmp",
  workdirBrowseEnabled: false,
  skipPermissions: false,
  showText: "full",
  showReasoning: "off",
  showToolUse: "off",
  showStepStart: "off",
  showStepFinish: "off",
};

// ── session management ────────────────────────────────

describe("MimoClient session management", () => {
  it("setSession / getSessionId round-trips", () => {
    const client = new MimoClient(baseConfig);
    client.setSession("chat1", "sess-abc");
    expect(client.getSessionId("chat1")).toBe("sess-abc");
  });

  it("getSessionId returns undefined for unknown chat", () => {
    const client = new MimoClient(baseConfig);
    expect(client.getSessionId("unknown")).toBeUndefined();
  });

  it("clearSession removes session, model, and agent", () => {
    const client = new MimoClient(baseConfig);
    client.setSession("chat1", "sess-abc");
    client.setModel("chat1", "gpt-4");
    client.setAgent("chat1", "plan");
    client.clearSession("chat1");
    expect(client.getSessionId("chat1")).toBeUndefined();
    expect(client.getModel("chat1")).toBeUndefined();
    expect(client.getAgent("chat1")).toBeUndefined();
  });
});

// ── model management ──────────────────────────────────

describe("MimoClient model management", () => {
  it("setModel / getModel round-trips", () => {
    const client = new MimoClient(baseConfig);
    client.setModel("chat1", "gpt-4");
    expect(client.getModel("chat1")).toBe("gpt-4");
  });

  it("getModel returns undefined when not set", () => {
    const client = new MimoClient(baseConfig);
    expect(client.getModel("chat1")).toBeUndefined();
  });
});

// ── agent management ──────────────────────────────────

describe("MimoClient agent management", () => {
  it("setAgent / getAgent round-trips", () => {
    const client = new MimoClient(baseConfig);
    client.setAgent("chat1", "compose");
    expect(client.getAgent("chat1")).toBe("compose");
  });

  it("getAgent returns undefined when not set", () => {
    const client = new MimoClient(baseConfig);
    expect(client.getAgent("chat1")).toBeUndefined();
  });
});

// ── abort ─────────────────────────────────────────────

describe("MimoClient.abort", () => {
  it("returns false when no process for chatId", () => {
    const client = new MimoClient(baseConfig);
    expect(client.abort("chat1")).toBe(false);
  });
});

// ── workdir management ────────────────────────────────

describe("MimoClient workdir management", () => {
  it("getWorkDir returns initial config workDir", () => {
    const client = new MimoClient(baseConfig);
    expect(client.getWorkDir()).toBe("/tmp");
  });

  it("setWorkDir dynamically updates the workDir", () => {
    const client = new MimoClient(baseConfig);
    client.setWorkDir("/tmp/workdir-x");
    expect(client.getWorkDir()).toBe("/tmp/workdir-x");
  });
});
