# Plan 005: Fix memory leak in lastSessions map

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

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `d508809`, 2026-06-11

## Why this matters

Every `/sessions` command stores up to 15 session objects per chat in the
`lastSessions` Map. This Map is never evicted — over a long-running instance
with many chats, it grows without bound. Each entry holds an array of
`{ id: string, title: string }` objects. For most users this is minor (they
have one chat), but for shared bot instances or bots in multiple groups,
the leak is real.

## Current state

File: `src/bot.ts`

Declaration at line 127:
```typescript
const lastSessions = new Map<string, Array<{ id: string; title: string }>>();
```

Write at line 318 (inside `/sessions` handler):
```typescript
lastSessions.set(chatId, sessions.map((s) => ({ id: s.id, title: s.title })));
```

Read at line 587 (inside `message:text` handler):
```typescript
const sessions = lastSessions.get(chatId);
```

Delete at line 593:
```typescript
lastSessions.delete(chatId);
```

**Problem**: Entries are added on every `/sessions` call but only deleted
when the user picks a session by number. If the user calls `/sessions`
repeatedly without picking, entries pile up. If the bot runs for days with
many users, this leaks.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run typecheck`      | exit 0, no errors   |
| Tests     | `bun test`               | all pass            |

## Scope

**In scope**:
- `src/bot.ts` — add eviction strategy for `lastSessions`

**Out of scope**:
- The `/sessions` handler logic
- The session switching logic in `message:text`
- Any other Map cleanup

## Git workflow

- Branch: `advisor/005-memory-leak-sessions`
- Commit message: `fix: add eviction for lastSessions map entries`
- Do NOT push or open a PR.

## Steps

### Step 1: Add a TTL-based eviction

The simplest fix: before storing a new entry, clear any stale ones. Since
`lastSessions` is only used for session switching (a brief UI flow), entries
older than 5 minutes are stale — the user won't be switching to them.

Add a timestamp to the stored data and evict on write:

Change the Map declaration from:
```typescript
const lastSessions = new Map<string, Array<{ id: string; title: string }>>();
```

To:
```typescript
const lastSessions = new Map<string, { sessions: Array<{ id: string; title: string }>; ts: number }>();
```

At the `/sessions` handler write point (line 318), change:
```typescript
lastSessions.set(chatId, sessions.map((s) => ({ id: s.id, title: s.title })));
```

To:
```typescript
const now = Date.now();
// Evict entries older than 5 minutes
for (const [key, val] of lastSessions) {
  if (now - val.ts > 5 * 60_000) lastSessions.delete(key);
}
lastSessions.set(chatId, {
  sessions: sessions.map((s) => ({ id: s.id, title: s.title })),
  ts: now,
});
```

At the read point (line 587), change:
```typescript
const sessions = lastSessions.get(chatId);
if (sessions && num <= sessions.length) {
  const target = sessions[num - 1];
```

To:
```typescript
const entry = lastSessions.get(chatId);
if (entry && num <= entry.sessions.length) {
  const target = entry.sessions[num - 1];
```

**Verify**: `bun run typecheck` → exit 0

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0
- [ ] `grep -n "lastSessions" src/bot.ts` shows entries with `ts` property
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back if:

- The code at the locations in "Current state" doesn't match the excerpts.
- A step's verification fails twice.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

- The 5-minute TTL is generous — session switching is a sub-second UI flow.
  If users report the session switch expiring too fast, increase the TTL.
- An alternative (but more complex) approach would be an LRU with a max size
  of ~100 entries. The TTL approach is simpler and sufficient for this use case.
