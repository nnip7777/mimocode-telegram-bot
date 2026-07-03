import { type ChildProcess, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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
  imagePath?: string;
  onEvent?: (event: Record<string, unknown>) => void;
};

export class MimoClient {
  private workDir: string;
  private readonly mimoApiUrl?: string;
  private readonly skipPermissions: boolean;
  private readonly runTimeoutMs: number;
  private readonly contextLimit: number;
  private sessions: Map<string, string> = new Map();
  private processes: Map<string, ChildProcess> = new Map();
  private chatModels: Map<string, string> = new Map();
  private chatAgents: Map<string, string> = new Map();
  private sessionTokens: Map<string, number> = new Map();
  private cachedVersion: string | undefined;

  constructor(config: Config) {
    this.workDir = config.mimoWorkDir;
    this.mimoApiUrl = config.mimoApiUrl;
    this.skipPermissions = config.skipPermissions;
    this.runTimeoutMs = config.runTimeoutMs;
    this.contextLimit = config.contextLimit;
  }

  clearSession(chatId: string): void {
    this.sessions.delete(chatId);
    this.chatModels.delete(chatId);
    this.chatAgents.delete(chatId);
    this.sessionTokens.delete(chatId);
  }

  private trackTokens(chatId: string, tokens: number): void {
    const prev = this.sessionTokens.get(chatId) ?? 0;
    this.sessionTokens.set(chatId, prev + tokens);
  }

  private shouldRotate(chatId: string): boolean {
    const tokens = this.sessionTokens.get(chatId) ?? 0;
    return tokens >= this.contextLimit;
  }

  getWorkDir(): string {
    return this.workDir;
  }

  setWorkDir(workDir: string): void {
    this.workDir = workDir;
  }

  setSession(chatId: string, sessionId: string): void {
    this.sessions.set(chatId, sessionId);
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

  private spawnProcess(args: string[]): ChildProcess {
    return spawn("mimo", args, {
      cwd: this.workDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  }

  private spawnStreaming(
    args: string[],
    chatId: string,
    onStdout: (chunk: Buffer) => void,
    _onEvent?: (event: Record<string, unknown>) => void,
  ): Promise<{ stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const proc = this.spawnProcess(args);
      this.processes.set(chatId, proc);

      let stderr = "";

      proc.stdout?.on("data", onStdout);
      proc.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));

      proc.on("close", (code) => {
        this.processes.delete(chatId);
        resolve({ stderr, code: code ?? -1 });
      });

      proc.on("error", (err) => {
        this.processes.delete(chatId);
        reject(new Error(`Failed to spawn mimo: ${err.message}`));
      });
    });
  }

  async exec(
    args: string[],
    opts?: { timeoutMs?: number },
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((resolve, reject) => {
      const proc = this.spawnProcess(args);

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
    if (this.cachedVersion) return this.cachedVersion;
    const r = await this.exec(["--version"], { timeoutMs: 5000 });
    const version = r.stdout.trim();
    if (version) this.cachedVersion = version;
    return version;
  }

  private async httpPost(
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await fetch(`${this.mimoApiUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.runTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    }
    return res.json();
  }

  async sendMessage(
    chatId: string,
    text: string,
    opts?: SendMessageOpts,
  ): Promise<MimoResponse> {
    const sessionId = this.sessions.get(chatId);
    const model = opts?.model ?? this.chatModels.get(chatId);
    const agent = opts?.agent ?? this.chatAgents.get(chatId);

    const runMimo = async (
      sessionToUse?: string,
      contextPrefix?: string,
    ): Promise<MimoResponse> => {
      let fullText = contextPrefix ? `${contextPrefix}\n\n---\n\n${text}` : text;

      if (opts?.imagePath) {
        try {
          const buf = await readFile(opts.imagePath);
          const ext = opts.imagePath.split(".").pop()?.toLowerCase() ?? "png";
          const mimeMap: Record<string, string> = {
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            png: "image/png",
            gif: "image/gif",
            webp: "image/webp",
            bmp: "image/bmp",
            svg: "image/svg+xml",
            pdf: "application/pdf",
          };
          const mime = mimeMap[ext] ?? `image/${ext}`;
          const b64 = buf.toString("base64");
          fullText = `[Image (${mime}): data:${mime};base64,${b64.slice(0, 100)}...]\n\n${fullText}`;
        } catch (err) {
          console.warn(`[mimo] failed to read image ${opts.imagePath}:`, err);
        }
      }

      if (this.mimoApiUrl) {
        const sid = sessionToUse ?? await this.createSession();
        const parts: Array<Record<string, unknown>> = [];
        parts.push({ type: "text", text: fullText });
        const body: Record<string, unknown> = { parts };
        if (model) body.model = model;
        if (agent) body.agent = agent;
        if (opts?.thinking) body.thinking = true;

        const result = (await this.httpPost(
          `/session/${sid}/message`,
          body,
        )) as {
          parts?: Array<{ type: string; text?: string }>;
        };

        let fullContent = "";
        if (result.parts) {
          for (const part of result.parts) {
            if (part.type === "text" && part.text) {
              fullContent += part.text;
            }
          }
        }

        this.sessions.set(chatId, sid);

        const inputTokens = text.length / 4;
        const outputTokens = fullContent.length / 4;
        this.trackTokens(chatId, inputTokens + outputTokens);

        return { content: fullContent, sessionId: sid };
      }

      const args = ["run", fullText, "--format", "json"];
      if (this.skipPermissions) {
        args.push("--dangerously-skip-permissions");
      }
      if (sessionToUse) {
        args.push("--session", sessionToUse);
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

      let fullContent = "";
      let newSessionId = sessionToUse ?? "";

      const { stderr, code } = await this.spawnStreaming(
        args,
        chatId,
        (chunk: Buffer) => {
          const lines = chunk.toString().split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const event = JSON.parse(line) as Record<string, unknown>;
              if (opts?.onEvent) opts.onEvent(event);
              if (event.type === "text") {
                const part = event.part as { text?: string } | undefined;
                if (part?.text) {
                  fullContent += part.text;
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
        },
      );

      if (code !== 0 && !fullContent) {
        throw new Error(
          `mimo run failed (code ${code}): ${stderr.slice(0, 200)}`,
        );
      }
      if (fullContent === "" && /Session not found/.test(stderr)) {
        throw new Error(
          `mimo run failed: Session not found: ${stderr.slice(0, 200)}`,
        );
      }
      if (newSessionId) {
        this.sessions.set(chatId, newSessionId);
      }

      const inputTokens = text.length / 4;
      const outputTokens = fullContent.length / 4;
      this.trackTokens(chatId, inputTokens + outputTokens);

      return { content: fullContent, sessionId: newSessionId };
    };

    if (this.shouldRotate(chatId)) {
      console.warn(
        `[mimo] session ${sessionId} exceeded context limit (${this.contextLimit} tokens); auto-rotating`,
      );
      this.sessions.delete(chatId);
      this.sessionTokens.delete(chatId);
      return runMimo();
    }

    try {
      return await runMimo(sessionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const clean = msg.replace(/\x1b\[[0-9;]*m/g, "");
      if (sessionId && clean.includes("Session not found")) {
        console.warn(
          `[mimo] session ${sessionId} not found during run; retrying with a new session`,
        );
        this.sessions.delete(chatId);
        this.sessionTokens.delete(chatId);
        return runMimo();
      }
      throw err;
    }
  }

  private async createSession(): Promise<string> {
    const data = (await this.httpPost("/session", {
      directory: this.workDir,
    })) as { id: string };
    return data.id;
  }
}
