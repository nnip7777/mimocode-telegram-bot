# Plan 003: Sanitize error messages sent to users

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d508809..HEAD -- src/bot.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `d508809`, 2026-06-11

## Why this matters

Raw error messages from the `mimo` CLI (file paths, process details, internal
error text) are sent directly to Telegram users. In a multi-user bot scenario,
this leaks server internals. The stderr output can contain file system paths,
process IDs, and mimo internal error details.

## Current state

File: `src/bot.ts` — multiple locations send raw errors to users:

Line 221:
```typescript
await ctx.reply(`Failed to clear old session: ${r.stderr.slice(0, 200)}`);
```

Line 409 (and 449):
```typescript
const msg = err instanceof Error ? err.message : String(err);
try { await ctx.reply(`Error: ${msg}`); } catch {}
```

Line 501:
```typescript
await ctx.reply(`Export failed: ${r.stderr.slice(0, 200)}`);
```

Lines 554 (and similar):
```typescript
await ctx.reply(`Delete failed: ${r.stderr.slice(0, 200)}`);
```

Line 620:
```typescript
console.error(`[${new Date().toISOString()}] Error: msg`);
try { await ctx.reply(`Error: ${msg}`); } catch {}
```

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run typecheck`      | exit 0, no errors   |
| Tests     | `bun test`               | all pass            |

## Scope

**In scope**:
- `src/bot.ts` — sanitize all user-facing error messages

**Out of scope**:
- `console.error` / `console.warn` logs (these are server-side, not user-facing)
- `src/mimo.ts` error handling (those errors are re-thrown, not shown to users)
- Changing the error handling flow itself

## Git workflow

- Branch: `advisor/003-error-message-leaks`
- Commit message: `fix: sanitize error messages shown to Telegram users`
- Do NOT push or open a PR.

## Steps

### Step 1: Add a sanitizeError helper to bot.ts

At the top of `src/bot.ts`, after the existing helper functions (after
`parseJsonSafe`), add:

```typescript
/** Strip internal details from error messages before showing to users. */
function sanitizeError(raw: string): string {
  // Remove file paths (Unix and common patterns)
  let clean = raw
    .replace(/\/[\w./-]+/g, "<path>")
    .replace(/[A-Z]:\\[\w\\.-]+/gi, "<path>");
  // Remove ANSI escape sequences
  clean = clean.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
  // Truncate
  if (clean.length > 100) clean = clean.slice(0, 100) + "...";
  return clean || "Unknown error";
}
```

**Verify**: `bun run typecheck` → exit 0

### Step 2: Replace all user-facing error messages

Replace every instance where raw error output is sent to the user:

1. `bot.ts:221` — change `r.stderr.slice(0, 200)` → `sanitizeError(r.stderr)`
2. `bot.ts:409` and `bot.ts:449` — change `${msg}` → `sanitizeError(msg)` in
   the `ctx.reply` calls
3. `bot.ts:501` — change `r.stderr.slice(0, 200)` → `sanitizeError(r.stderr)`
4. `bot.ts:554` — change `r.stderr.slice(0, 200)` → `sanitizeError(r.stderr)`
5. `bot.ts:620` — change the user-facing reply (not the console.error) to use
   `sanitizeError(msg)` instead of `${msg}`

Keep `console.error` and `console.warn` calls unchanged — those are
server-side logs that should retain full detail.

**Verify**: `bun run typecheck` → exit 0

### Step 3: Verify

Run the full verification suite:

**Verify**:
- `bun run typecheck` → exit 0
- `bun test` → all tests pass
- `grep -n "slice(0, 200)" src/bot.ts` → no matches (all replaced with sanitizeError)
- `grep -n 'ctx.reply.*`Error:.*\${msg}' src/bot.ts` → no matches

## Test plan

If plan 001's test infrastructure exists:
- Add a test for `sanitizeError` in `src/bot.test.ts` or a new test file:
  - Input with file path → path replaced with `<path>`
  - Input with ANSI codes → codes stripped
  - Long input → truncated to ~100 chars
  - Empty input → returns "Unknown error"
- If plan 001 doesn't exist yet, skip the test addition — the function is
  simple enough that manual verification suffices.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0 (if tests exist)
- [ ] `grep -n "slice(0, 200)" src/bot.ts` returns no matches
- [ ] `grep -n "sanitizeError" src/bot.ts` returns at least 5 matches
- [ ] `console.error` and `console.warn` calls are unchanged
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back if:

- The code at the locations in "Current state" doesn't match the excerpts.
- A step's verification fails twice.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

- Future error messages in new handlers must use `sanitizeError()` before
  sending to users.
- Server-side logs (`console.error`, `console.warn`) must keep full detail.
- The `sanitizeError` function is intentionally aggressive — false positives
  (legitimate user content getting sanitized) are unlikely since error
  messages from `mimo` CLI don't contain user chat text.
