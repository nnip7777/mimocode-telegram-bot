# Plan 007: Replace sessionExists RPC with lazy validation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d508809..HEAD -- src/mimo.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `d508809`, 2026-06-11

## Why this matters

Every call to `sendMessage()` spawns `mimo session list --format json` just
to validate whether the stored session ID still exists. This is an extra
process spawn on every single message — adding latency and process overhead.
The code already handles the "session not found" error gracefully in the
`catch` block (lines 239-249), so the upfront validation is redundant.

## Current state

File: `src/mimo.ts`

Lines 129-146 (in `sendMessage`):
```typescript
async sendMessage(chatId: string, text: string, opts?: SendMessageOpts): Promise<MimoResponse> {
  const storedSessionId = this.sessions.get(chatId);
  if (storedSessionId) {
    const exists = await this.sessionExists(storedSessionId);  // RPC every time
    if (!exists) {
      console.warn(`[mimo] session ${storedSessionId} not found; starting new session`);
      this.sessions.delete(chatId);
    }
  }

  const sessionId = this.sessions.get(chatId);
  // ... rest of sendMessage
```

Lines 117-127 (`sessionExists` method):
```typescript
private async sessionExists(sessionId: string): Promise<boolean> {
  const r = await this.exec(["session", "list", "--format", "json"], { timeoutMs: 5000 });
  if (r.code !== 0) return false;

  try {
    const sessions = JSON.parse(r.stdout) as Array<{ id?: string }>;
    return sessions.some((s) => s.id === sessionId);
  } catch {
    return false;
  }
}
```

Lines 239-249 (existing fallback):
```typescript
try {
  return await runMimo(sessionId);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  const clean = msg.replace(/\x1b\[[0-9;]*m/g, "");
  if (sessionId && clean.includes("Session not found")) {
    console.warn(`[mimo] session ${sessionId} not found during run; retrying with a new session`);
    this.sessions.delete(chatId);
    return runMimo();
  }
  throw err;
}
```

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run typecheck`      | exit 0, no errors   |
| Tests     | `bun test`               | all pass            |

## Scope

**In scope**:
- `src/mimo.ts` — remove `sessionExists` method and upfront validation in `sendMessage`

**Out of scope**:
- The `catch` block fallback in `sendMessage` (lines 239-249) — this stays as-is
- `exec` method
- Error handling flow changes

## Git workflow

- Branch: `advisor/007-session-exists-rpc`
- Commit message: `perf: remove redundant sessionExists check before every run`
- Do NOT push or open a PR.

## Steps

### Step 1: Remove sessionExists call from sendMessage

In `src/mimo.ts`, remove the upfront validation block in `sendMessage`:

Change lines 134-141 from:
```typescript
const storedSessionId = this.sessions.get(chatId);
if (storedSessionId) {
  const exists = await this.sessionExists(storedSessionId);
  if (!exists) {
    console.warn(`[mimo] session ${storedSessionId} not found; starting new session`);
    this.sessions.delete(chatId);
  }
}

const sessionId = this.sessions.get(chatId);
```

To:
```typescript
const sessionId = this.sessions.get(chatId);
```

The existing `catch` block at lines 239-249 already handles the case where
the session doesn't exist during `mimo run` — it deletes the session and
retries without one.

**Verify**: `bun run typecheck` → exit 0

### Step 2: Remove the sessionExists method

Delete the entire `sessionExists` private method (lines 117-127) since it's
no longer called anywhere:

```typescript
private async sessionExists(sessionId: string): Promise<boolean> {
  // ... entire method
}
```

**Verify**: `bun run typecheck` → exit 0
**Verify**: `grep -n "sessionExists" src/mimo.ts` → no matches

### Step 3: Verify behavior is preserved

The existing catch block at lines 239-249 (now the only "session not found"
handler) already:
1. Catches the error from `mimo run`
2. Checks if it's a "Session not found" error
3. Deletes the invalid session
4. Retries with a new session

This is functionally equivalent to the removed upfront check, but triggered
lazily (only when the session is actually invalid) instead of eagerly
(checking on every message).

**Verify**: `bun test` → all tests pass

## Test plan

If plan 001's test infrastructure exists, verify that the existing tests
still pass. No new tests needed — the behavior change is that validation
now happens lazily instead of eagerly, which is tested implicitly by the
integration path.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0
- [ ] `grep -n "sessionExists" src/mimo.ts` returns no matches
- [ ] The `catch` block in `sendMessage` (lines 239-249) is unchanged
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back if:

- The code at the locations in "Current state" doesn't match the excerpts.
- A step's verification fails twice.
- The fix appears to require touching an out-of-scope file.
- `sessionExists` is called from somewhere other than `sendMessage` (it's
  private and only used once, but verify with grep).

## Maintenance notes

- The retry-once pattern in the catch block is correct: if the session is
  truly gone, the first `runMimo(sessionId)` fails, catch deletes it, and
  `runMimo()` starts fresh. This is the standard pattern for lazy validation.
- If in the future there's a need to eagerly validate sessions (e.g. for
  a "validate session" command), add a public method then — don't bring back
  the per-message overhead.
- The `M` effort reflects the risk: removing an explicit check and relying
  on error-driven fallback requires confidence that the fallback path is
  complete. The existing code at lines 239-249 is that path and it's solid.
