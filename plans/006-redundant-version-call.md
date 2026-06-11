# Plan 006: Remove redundant --version call on startup

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d508809..HEAD -- src/index.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `d508809`, 2026-06-11

## Why this matters

On startup, `index.ts` spawns `mimo --version` via a raw `spawn()` call
(line 29-34) just to check if mimo is available and print its version. This
is independent of the `MimoClient` class which has its own `getVersion()`
method. The startup check spawns a process that is never reused — a minor
but unnecessary overhead. More importantly, it duplicates logic that
`MimoClient` already provides.

## Current state

File: `src/index.ts`

Lines 28-40:
```typescript
// Check if mimo CLI is available
const { spawn } = await import("node:child_process");
const check = spawn("mimo", ["--version"], { stdio: "ignore" });
const mimoOk = await new Promise<boolean>((resolve) => {
  check.on("close", (code) => resolve(code === 0));
  check.on("error", () => resolve(false));
});

if (mimoOk) {
  console.log("  MiMoCode CLI:  OK");
} else {
  console.warn("  MiMoCode CLI:  NOT FOUND (install: npm i -g @mimo-ai/cli)");
}
```

This is completely independent of the `MimoClient` created at line 17.
The `MimoClient` already has a `ping()` method (`mimo.ts:107-109`) and
`getVersion()` (`mimo.ts:112-114`).

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run typecheck`      | exit 0, no errors   |
| Tests     | `bun test`               | all pass            |

## Scope

**In scope**:
- `src/index.ts` — replace raw spawn with MimoClient method

**Out of scope**:
- `src/mimo.ts` — no changes needed
- `src/bot.ts` — no changes needed

## Git workflow

- Branch: `advisor/006-redundant-version-call`
- Commit message: `fix: use MimoClient.ping for startup CLI check`
- Do NOT push or open a PR.

## Steps

### Step 1: Replace raw spawn with MimoClient.ping()

The `createBot` function already creates a `MimoClient` inside, but `index.ts`
doesn't have access to it. However, we can create a temporary `MimoClient` for
the health check, or we can refactor `createBot` to also return the client.

The simplest approach: create a standalone `MimoClient` instance for the check,
since it's a lightweight object.

Replace lines 28-40 in `src/index.ts` with:

```typescript
import { MimoClient } from "./mimo.js";

// ...

// Check if mimo CLI is available
const checkMimo = new MimoClient(config);
const mimoOk = await checkMimo.ping();

if (mimoOk) {
  console.log("  MiMoCode CLI:  OK");
} else {
  console.warn("  MiMoCode CLI:  NOT FOUND (install: npm i -g @mimo-ai/cli)");
}
```

Move the `import { MimoClient }` to the top of the file with the other
imports. Remove the dynamic `await import("node:child_process")`.

**Verify**: `bun run typecheck` → exit 0

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0
- [ ] `grep -n "spawn.*mimo" src/index.ts` returns no matches
- [ ] `grep -n "MimoClient" src/index.ts` returns at least 1 match
- [ ] `grep -n "node:child_process" src/index.ts` returns no matches
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back if:

- The code at the locations in "Current state" doesn't match the excerpts.
- A step's verification fails twice.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

- The `MimoClient.ping()` method already exists and does exactly what the
  raw spawn was doing — checking if `mimo --version` succeeds.
- The two `MimoClient` instances (one in index.ts for the check, one inside
  `createBot`) are independent — they don't share state. This is fine for
  a startup check that happens once.
