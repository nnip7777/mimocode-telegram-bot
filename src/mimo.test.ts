import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { Config } from "./config.js";
import { MimoClient } from "./mimo.js";

const baseConfig: Config = {
  telegramToken: "test-token",
  allowedUserIds: ["111"],
  mimoWorkDir: "/tmp",
  skipPermissions: false,
  runTimeoutMs: 120_000,
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

// ── idle timeout (spawnStreaming) ─────────────────────

type SpawnStreamingFn = (
  args: string[],
  chatId: string,
  onStdout: (chunk: Buffer) => void,
  opts?: { timeoutMs?: number },
) => Promise<{ stderr: string; code: number }>;

describe("MimoClient idle timeout", () => {
  it("resets timeout on stdout data, completes without error", async () => {
    const client = new MimoClient(baseConfig);

    let stdoutEmitter: EventEmitter;
    let procEmitter: EventEmitter;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).spawnProcess = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = mock(() => {
        (procEmitter as unknown as EventEmitter).emit("close", -1);
      });
      proc.killed = false;
      stdoutEmitter = proc.stdout as EventEmitter;
      procEmitter = proc as unknown as EventEmitter;
      return proc;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promise = ((client as any).spawnStreaming as SpawnStreamingFn)(
      ["run", "hello"],
      "chat1",
      () => {},
      { timeoutMs: 100 },
    );

    // Emit data every 80ms to keep alive (timeout is 100ms)
    const interval = setInterval(() => {
      stdoutEmitter!.emit("data", Buffer.from("x"));
    }, 80);

    // Close after 300ms — timer should have been reset multiple times
    await new Promise((r) => setTimeout(r, 300));
    clearInterval(interval);
    procEmitter!.emit("close", 0);

    const result = await promise;
    expect(result.code).toBe(0);
  });

  it("resets timeout on stderr data, completes without error", async () => {
    const client = new MimoClient(baseConfig);

    let stderrEmitter: EventEmitter;
    let procEmitter: EventEmitter;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).spawnProcess = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = mock(() => {
        (procEmitter as unknown as EventEmitter).emit("close", -1);
      });
      proc.killed = false;
      stderrEmitter = proc.stderr as EventEmitter;
      procEmitter = proc as unknown as EventEmitter;
      return proc;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promise = ((client as any).spawnStreaming as SpawnStreamingFn)(
      ["run", "hello"],
      "chat1",
      () => {},
      { timeoutMs: 100 },
    );

    // Emit stderr data every 80ms
    const interval = setInterval(() => {
      stderrEmitter!.emit("data", Buffer.from("progress..."));
    }, 80);

    await new Promise((r) => setTimeout(r, 300));
    clearInterval(interval);
    procEmitter!.emit("close", 0);

    const result = await promise;
    expect(result.code).toBe(0);
  });

  it("times out and kills process after no data for timeout period", async () => {
    const client = new MimoClient(baseConfig);

    let killCalled = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).spawnProcess = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = mock(() => {
        killCalled = true;
      });
      proc.killed = false;
      return proc;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promise = ((client as any).spawnStreaming as SpawnStreamingFn)(
      ["run", "hello"],
      "chat1",
      () => {},
      { timeoutMs: 100 },
    );

    await expect(promise).rejects.toThrow("timed out");
    expect(killCalled).toBe(true);
  });

  it("does not double-resolve after timeout and close race", async () => {
    const client = new MimoClient(baseConfig);

    let procEmitter: EventEmitter;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).spawnProcess = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = new EventEmitter() as any;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = mock(() => {
        // Simulate close event firing right after kill
        setImmediate(() => {
          (procEmitter as unknown as EventEmitter).emit("close", -1);
        });
      });
      proc.killed = false;
      procEmitter = proc as unknown as EventEmitter;
      return proc;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promise = ((client as any).spawnStreaming as SpawnStreamingFn)(
      ["run", "hello"],
      "chat1",
      () => {},
      { timeoutMs: 100 },
    );

    // Should reject with timeout, not hang or double-resolve
    await expect(promise).rejects.toThrow("timed out");
  });
});
