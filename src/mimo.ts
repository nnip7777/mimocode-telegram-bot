import { spawn } from "node:child_process";
import type { Config } from "./config.js";

export type MimoResponse = {
  readonly content: string;
  readonly sessionId?: string;
};

export class MimoClient {
  private readonly workDir: string;
  private sessions: Map<string, string> = new Map();

  constructor(config: Config) {
    this.workDir = config.mimoWorkDir;
  }

  clearSession(chatId: string): void {
    this.sessions.delete(chatId);
  }

  getSessionId(chatId: string): string | undefined {
    return this.sessions.get(chatId);
  }

  async exec(
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve) => {
      const proc = spawn("mimo", args, {
        cwd: this.workDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";
      let killed = false;
      const timeout = opts?.timeoutMs ?? 30_000;

      const timer = setTimeout(() => {
        killed = true;
        proc.kill("SIGTERM");
        resolve({ stdout, stderr: stderr + "\ntimed out", code: -1 });
      }, timeout);

      proc.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
      proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (!killed) resolve({ stdout, stderr, code: code ?? -1 });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        if (!killed) resolve({ stdout: "", stderr: err.message, code: -1 });
      });
    });
  }

  async ping(): Promise<boolean> {
    const r = await this.exec(["--version"], { timeoutMs: 5000 });
    return r.code === 0;
  }

  async getVersion(): Promise<string> {
    const r = await this.exec(["--version"], { timeoutMs: 5000 });
    return r.stdout.trim();
  }

  async sendMessage(
    chatId: string,
    text: string,
    onDelta: (delta: string) => void,
  ): Promise<MimoResponse> {
    const sessionId = this.sessions.get(chatId);

    const args = [
      "run", text,
      "--format", "json",
      "--dangerously-skip-permissions",
    ];
    if (sessionId) {
      args.push("--session", sessionId);
    }

    return new Promise((resolve, reject) => {
      const proc = spawn("mimo", args, {
        cwd: this.workDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let fullContent = "";
      let newSessionId = sessionId ?? "";
      let stderr = "";
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        proc.kill("SIGTERM");
        reject(new Error("mimo run timed out (120s)"));
      }, 120_000);

      proc.stdout?.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.type === "text") {
              const part = event.part as { text?: string } | undefined;
              if (part?.text) {
                fullContent += part.text;
                onDelta(part.text);
              }
            }
            if (typeof event.sessionID === "string" && event.sessionID) {
              newSessionId = event.sessionID;
            }
          } catch {
            // skip non-JSON lines
          }
        }
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (killed) return;
        if (code !== 0 && !fullContent) {
          reject(new Error(`mimo run failed (code ${code}): ${stderr.slice(0, 200)}`));
          return;
        }
        if (newSessionId) {
          this.sessions.set(chatId, newSessionId);
        }
        resolve({ content: fullContent, sessionId: newSessionId });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        if (!killed) {
          reject(new Error(`Failed to spawn mimo: ${err.message}`));
        }
      });
    });
  }
}
