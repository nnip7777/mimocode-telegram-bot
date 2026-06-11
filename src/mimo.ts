import { spawn, type ChildProcess } from "node:child_process";
import type { Config } from "./config.js";

export type MimoResponse = {
  readonly content: string;
  readonly sessionId?: string;
};

export type SendMessageOpts = {
  model?: string;
  agent?: string;
  thinking?: boolean;
  variant?: string;
};

export class MimoClient {
  private readonly workDir: string;
  private readonly mimoApiUrl?: string;
  private readonly skipPermissions: boolean;
  private sessions: Map<string, string> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private chatModels: Map<string, string> = new Map();
  private chatAgents: Map<string, string> = new Map();

  constructor(config: Config) {
    this.workDir = config.mimoWorkDir;
    this.mimoApiUrl = config.mimoApiUrl;
    this.skipPermissions = config.skipPermissions;
  }

  clearSession(chatId: string): void {
    this.sessions.delete(chatId);
    this.chatModels.delete(chatId);
    this.chatAgents.delete(chatId);
  }

  getSessionId(chatId: string): string | undefined {
    return this.sessions.get(chatId);
  }

  getModel(chatId: string): string | undefined {
    return this.chatModels.get(chatId);
  }

  setModel(chatId: string, model: string): void {
    this.chatModels.set(chatId, model);
  }

  getAgent(chatId: string): string | undefined {
    return this.chatAgents.get(chatId);
  }

  setAgent(chatId: string, agent: string): void {
    this.chatAgents.set(chatId, agent);
  }

  abort(chatId: string): boolean {
    const proc = this.processes.get(chatId);
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
      this.processes.delete(chatId);
      return true;
    }
    this.processes.delete(chatId);
    return false;
  }

  async exec(
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn("mimo", args, {
        cwd: this.workDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";
      const timeout = opts?.timeoutMs ?? 30_000;

      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`mimo ${args[0]} timed out (${timeout}ms)`));
      }, timeout);

      proc.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
      proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: code ?? -1 });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ stdout: "", stderr: err.message, code: -1 });
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
    opts?: SendMessageOpts,
  ): Promise<MimoResponse> {
    const sessionId = this.sessions.get(chatId);
    const model = opts?.model ?? this.chatModels.get(chatId);
    const agent = opts?.agent ?? this.chatAgents.get(chatId);

    const args = [
      "run", text,
      "--format", "json",
    ];
    if (this.skipPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    if (this.mimoApiUrl) {
      args.push("--attach", this.mimoApiUrl, "--dir", this.workDir);
    }
    if (sessionId) {
      args.push("--session", sessionId);
    }
    if (model) {
      args.push("--model", model);
    }
    if (agent) {
      args.push("--agent", agent);
    }
    if (opts?.thinking) {
      args.push("--thinking");
    }
    if (opts?.variant) {
      args.push("--variant", opts.variant);
    }

    return new Promise((resolve, reject) => {
      const proc = spawn("mimo", args, {
        cwd: this.workDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });

      this.processes.set(chatId, proc);

      let fullContent = "";
      let newSessionId = sessionId ?? "";
      let stderr = "";

      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        this.processes.delete(chatId);
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
            if (typeof event.sessionId === "string" && event.sessionId) {
              newSessionId = event.sessionId;
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
        this.processes.delete(chatId);
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
        this.processes.delete(chatId);
        reject(new Error(`Failed to spawn mimo: ${err.message}`));
      });
    });
  }
}
