# Plan 008: Make mimo run timeout configurable

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d508809..HEAD -- src/mimo.ts src/config.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `d508809`, 2026-06-11

## Why this matters

The `mimo run` timeout is hardcoded to 120 seconds. Complex coding tasks
(multi-file edits, large refactors) routinely exceed this. Users get an
unclear timeout error with no way to override it. Making it configurable
via environment variable gives power users control while keeping the sane
default.

## Current state

File: `src/mimo.ts`, line 186-189 (inside `runMimo` closure in `sendMessage`):
```typescript
const timer = setTimeout(() => {
  proc.kill("SIGTERM");
  this.processes.delete(chatId);
  reject(new Error("mimo run timed out (120s)"));
}, 120_000);
```

The `Config` type in `src/config.ts`:
```typescript
export type Config = {
  readonly telegramToken: string;
  readonly allowedUserIds: readonly string[];
  readonly mimoWorkDir: string;
  readonly mimoApiUrl?: string;
  readonly skipPermissions: boolean;
};
```

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run typecheck`      | exit 0, no errors   |
| Tests     | `bun test`               | all pass            |

## Scope

**In scope**:
- `src/config.ts` — add `runTimeoutMs` to Config type and loadConfig
- `src/mimo.ts` — use config value instead of hardcoded 120_000
- `.env.example` — document the new variable

**Out of scope**:
- Changes to other timeout values (exec method timeout)
- Changes to how timeout errors are displayed to users

## Git workflow

- Branch: `advisor/008-configurable-timeout`
- Commit message: `feat: make mimo run timeout configurable via MIMO_RUN_TIMEOUT_MS`
- Do NOT push or open a PR.

## Steps

### Step 1: Add runTimeoutMs to Config type

In `src/config.ts`, add to the `Config` type:
```typescript
export type Config = {
  readonly telegramToken: string;
  readonly allowedUserIds: readonly string[];
  readonly mimoWorkDir: string;
  readonly mimoApiUrl?: string;
  readonly skipPermissions: boolean;
  readonly runTimeoutMs: number;  // NEW
};
```

In `loadConfig()`, add:
```typescript
const runTimeoutMsRaw = process.env.MIMO_RUN_TIMEOUT_MS;
const runTimeoutMs = runTimeoutMsRaw ? Number(runTimeoutMsRaw) : 120_000;
if (Number.isNaN(runTimeoutMs) || runTimeoutMs <= 0) {
  throw new Error("MIMO_RUN_TIMEOUT_MS must be a positive number (milliseconds)");
}
```

And add `runTimeoutMs` to the returned object.

**Verify**: `bun run typecheck` → exit 0

### Step 2: Use config value in MimoClient

In `src/mimo.ts`, the constructor already receives `config`. Store the value:

```typescript
private readonly runTimeoutMs: number;

constructor(config: Config) {
  this.workDir = config.mimoWorkDir;
  this.mimoApiUrl = config.mimoApiUrl;
  this.skipPermissions = config.skipPermissions;
  this.runTimeoutMs = config.runTimeoutMs ?? 120_000;  // NEW
}
```

In the `runMimo` closure, replace the hardcoded timeout:

```typescript
// Before:
}, 120_000);

// After:
}, this.runTimeoutMs);
```

And update the error message:
```typescript
// Before:
reject(new Error("mimo run timed out (120s)"));

// After:
reject(new Error(`mimo run timed out (${this.runTimeoutMs / 1000}s)`));
```

**Verify**: `bun run typecheck` → exit 0

### Step 3: Document in .env.example

Add to `.env.example`:
```bash
# Maximum time (ms) for a single mimo run (default: 120000 = 2 minutes)
# MIMO_RUN_TIMEOUT_MS=300000
```

**Verify**: `grep "MIMO_RUN_TIMEOUT_MS" .env.example` → matches

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0
- [ ] `grep -n "120_000" src/mimo.ts` returns no matches (replaced with this.runTimeoutMs)
- [ ] `grep -n "runTimeoutMs" src/config.ts` returns at least 1 match
- [ ] `grep -n "MIMO_RUN_TIMEOUT_MS" .env.example` returns a match
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back if:

- The code at the locations in "Current state" doesn't match the excerpts.
- A step's verification fails twice.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

- The default of 120s preserves current behavior. Users who need longer can
  set `MIMO_RUN_TIMEOUT_MS=300000` (5 minutes) or similar.
- The validation in `loadConfig` rejects NaN and non-positive values to
  prevent obviously wrong configurations.
