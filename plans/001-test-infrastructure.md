# Plan 001: Add test infrastructure and characterization tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d508809..HEAD -- src/ package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `d508809`, 2026-06-11

## Why this matters

This codebase has zero tests. Every subsequent plan that touches bot logic,
markdown parsing, or session management carries regression risk. Establishing
a test framework and writing characterization tests for the existing pure
functions creates a safety net and unblocks the refactoring plans (009, 010).

## Current state

- **Runtime**: Bun (used for `bun run dev`, `bun run start`)
- **Language**: TypeScript (strict mode, ES2024 target)
- **Package manager**: Bun (`bun.lock`)
- **No test framework installed** — `package.json` has no `test` script
- **Source files** (all under `src/`):
  - `bot.ts` (632 lines) — Telegram bot setup and handlers
  - `mimo.ts` (252 lines) — MiMoCode CLI client
  - `config.ts` (48 lines) — Environment config loading
  - `index.ts` (77 lines) — Entry point

Excerpt from `package.json`:
```json
{
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts",
    "build": "bun build src/index.ts --outdir dist --target node --banner '#!/usr/bin/env node'",
    "typecheck": "bun x tsc --noEmit",
    "prepublishOnly": "bun run build"
  }
}
```

Repo convention: Uses Bun for all runtime and scripts. TypeScript strict mode.

## Commands you will need

| Purpose   | Command                          | Expected on success |
|-----------|----------------------------------|---------------------|
| Install   | `bun install`                    | exit 0              |
| Typecheck | `bun run typecheck`              | exit 0, no errors   |
| Tests     | `bun test`                       | all pass            |
| Lint      | `bun run lint` (not yet created) | —                   |

## Scope

**In scope**:
- `package.json` — add `test` script
- `src/config.test.ts` (create) — unit tests for `config.ts`
- `src/bot.test.ts` (create) — unit tests for pure helper functions extracted from `bot.ts`

**Out of scope**:
- Integration tests (require running mimo CLI or Telegram API)
- Test infrastructure beyond Bun's built-in test runner
- Any changes to source code logic

## Git workflow

- Branch: `advisor/001-test-infrastructure`
- Commit message: `test: add Bun test infrastructure and characterization tests`
- Do NOT push or open a PR.

## Steps

### Step 1: Add Bun test runner to package.json

Add a `"test"` script to `package.json`. Bun has a built-in test runner — no
additional dependencies needed.

Edit `package.json` and add to the `"scripts"` object:

```json
"test": "bun test"
```

**Verify**: `bun test --version` → shows Bun version

### Step 2: Write characterization tests for config.ts

Create `src/config.test.ts` with tests for the pure functions in `config.ts`.

The existing code has these testable functions:
- `env(key, fallback?)` — reads env var with fallback
- `envBool(key, fallback)` — reads boolean env var
- `loadConfig()` — full config loader (requires env vars set)
- `isAllowed(userId, config)` — auth check

Use Bun's built-in test runner (`bun:test` import). Pattern to follow:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";

describe("config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("isAllowed returns true for valid user ID", () => {
    const config = {
      telegramToken: "token",
      allowedUserIds: ["123", "456"],
      mimoWorkDir: "/tmp",
      skipPermissions: false,
    };
    expect(isAllowed("123", config)).toBe(true);
  });

  test("isAllowed returns false for unauthorized user ID", () => {
    const config = {
      telegramToken: "token",
      allowedUserIds: ["123"],
      mimoWorkDir: "/tmp",
      skipPermissions: false,
    };
    expect(isAllowed("999", config)).toBe(false);
  });
});
```

Test cases to cover:
- `isAllowed` with valid ID → true
- `isAllowed` with invalid ID → false
- `isAllowed` with empty allowedUserIds → true (current behavior, even though loadConfig prevents it — test the function as-is)
- `loadConfig` with valid env vars → returns correct Config
- `loadConfig` with missing TELEGRAM_BOT_TOKEN → throws
- `loadConfig` with empty TELEGRAM_ALLOWED_USER_ID → throws
- `loadConfig` with multiple comma-separated user IDs → correct array
- `loadConfig` with MIMO_SKIP_PERMISSIONS=true → skipPermissions is true
- `loadConfig` with MIMO_SKIP_PERMISSIONS=1 → skipPermissions is true
- `loadConfig` with MIMO_SKIP_PERMISSIONS=0 → skipPermissions is false

Export `env` and `envBool` from `config.ts` for testing, OR test them indirectly through `loadConfig`.

**Verify**: `bun test src/config.test.ts` → all tests pass

### Step 3: Write characterization tests for bot.ts helper functions

The helper functions in `bot.ts` (`escapeHtml`, `stripAnsi`, `stripSystemTags`,
`markdownToTelegramHtml`, `wrapCode`, `formatLong`, `parseJsonSafe`) are
currently not exported. To test them:

Option A (preferred): Extract the pure helper functions into `src/format.ts`
and import them in `bot.ts`. This is a minimal refactor — move the functions,
update imports, zero logic changes.

Option B: Test them indirectly through the bot (harder, requires mocking grammY).

**Go with Option A.** Create `src/format.ts` containing these functions:
- `escapeHtml(text: string): string`
- `stripAnsi(text: string): string`
- `stripSystemTags(text: string): string`
- `markdownToTelegramHtml(text: string): string`
- `wrapCode(text: string): string`
- `formatLong(text: string): string[]`
- `parseJsonSafe<T>(raw: string, fallback: T): T`

Then update `bot.ts` to import from `./format.js`.

Create `src/format.test.ts` with tests for each function:

```typescript
import { describe, test, expect } from "bun:test";
import {
  escapeHtml,
  stripAnsi,
  stripSystemTags,
  markdownToTelegramHtml,
  wrapCode,
  formatLong,
  parseJsonSafe,
} from "./format";
```

Test cases:
- `escapeHtml`: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, no-op on plain text
- `stripAnsi`: remove ANSI escape sequences, remove box-drawing chars, plain text unchanged
- `stripSystemTags`: removes `<system-reminder>...</system-reminder>` blocks, preserves surrounding text
- `markdownToTelegramHtml`: headings → bold, bold `**text**` → `<b>text</b>`, italic `_text_` → `<i>text</i>`, code blocks → `<pre><code>`, inline code → `<code>`, links → `<a>`, empty string → empty string
- `wrapCode`: wraps text in `<pre><code>` tags with HTML escaping
- `formatLong`: short text → single chunk, long text → multiple chunks each ≤3500 chars
- `parseJsonSafe`: valid JSON → parsed object, invalid JSON → fallback value

**Verify**: `bun test` → all tests pass (both config and format tests)

### Step 4: Verify no regressions

Run the full verification suite:

**Verify**:
- `bun run typecheck` → exit 0, no errors
- `bun test` → all tests pass
- `git diff --stat` → only shows `package.json`, `src/config.ts` (if exports added), `src/bot.ts` (if imports changed), `src/format.ts` (new), `src/config.test.ts` (new), `src/format.test.ts` (new)

## Test plan

Already included in steps above. Total expected test count: ~20-25 unit tests
covering config loading, auth checks, HTML escaping, ANSI stripping, markdown
conversion, text chunking, and JSON parsing.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0; at least 20 tests pass
- [ ] `src/format.ts` exists and is imported by `src/bot.ts`
- [ ] `src/config.test.ts` and `src/format.test.ts` exist
- [ ] `package.json` has a `"test": "bun test"` script
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back if:

- The code at the locations in "Current state" doesn't match the excerpts
  (the codebase has drifted since this plan was written).
- A step's verification fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file.
- Bun test runner has issues or behaves differently than expected.

## Maintenance notes

- If new helper functions are added to `bot.ts` in the future, they should
  go in `src/format.ts` instead and get corresponding tests.
- These are characterization tests (testing current behavior), not specification
  tests. Some edge cases in `markdownToTelegramHtml` may have debatable behavior.
  If the behavior is wrong, that's a separate finding (see plan 010).
