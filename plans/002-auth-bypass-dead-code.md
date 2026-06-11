# Plan 002: Remove dead auth bypass in isAllowed

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d508809..HEAD -- src/config.ts src/config.test.ts`
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

`isAllowed()` has a dead-code path that returns `true` when `allowedUserIds`
is empty. While `loadConfig()` currently prevents this state by throwing,
the guard in `isAllowed` is misleading — it suggests an empty list means
"allow all," which is the opposite of the project's security model. If code
is ever refactored to bypass `loadConfig`, this becomes an auth bypass.

## Current state

File: `src/config.ts`

```typescript
// line 45-48
export function isAllowed(userId: string, config: Config): boolean {
  if (config.allowedUserIds.length === 0) return true;  // DEAD CODE — unreachable
  return config.allowedUserIds.includes(userId);
}
```

`loadConfig()` at line 30-33 throws if `allowedUserIds` is empty:
```typescript
if (allowedUserIds.length === 0) {
  throw new Error(
    "TELEGRAM_ALLOWED_USER_ID is empty. Refusing to start: ..."
  );
}
```

The `Config` type at line 15-21 declares `allowedUserIds` as `readonly string[]`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run typecheck`      | exit 0, no errors   |
| Tests     | `bun test`               | all pass            |

## Scope

**In scope**:
- `src/config.ts` — remove dead guard in `isAllowed`
- `src/config.test.ts` — update test for isAllowed with empty array (should now return `false`, not `true`)

**Out of scope**:
- No other files should be modified
- Do not change `loadConfig` logic
- Do not add new validation

## Git workflow

- Branch: `advisor/002-auth-bypass-dead-code`
- Commit message: `fix: remove dead auth bypass in isAllowed`
- Do NOT push or open a PR.

## Steps

### Step 1: Remove dead code in isAllowed

In `src/config.ts`, change the `isAllowed` function from:

```typescript
export function isAllowed(userId: string, config: Config): boolean {
  if (config.allowedUserIds.length === 0) return true;
  return config.allowedUserIds.includes(userId);
}
```

To:

```typescript
export function isAllowed(userId: string, config: Config): boolean {
  return config.allowedUserIds.includes(userId);
}
```

**Verify**: `bun run typecheck` → exit 0

### Step 2: Update tests

If `src/config.test.ts` exists (from plan 001), update the test for
`isAllowed` with empty `allowedUserIds`:

- If there's a test asserting `isAllowed("any", { allowedUserIds: [] }) === true`,
  change it to assert `false` instead.

If `src/config.test.ts` doesn't exist yet, create it with at least this test:

```typescript
import { describe, test, expect } from "bun:test";
import { isAllowed } from "./config";

describe("isAllowed", () => {
  const baseConfig = {
    telegramToken: "token",
    mimoWorkDir: "/tmp",
    skipPermissions: false,
  };

  test("returns true for matching user ID", () => {
    expect(isAllowed("123", { ...baseConfig, allowedUserIds: ["123"] })).toBe(true);
  });

  test("returns false for non-matching user ID", () => {
    expect(isAllowed("999", { ...baseConfig, allowedUserIds: ["123"] })).toBe(false);
  });

  test("returns false for empty allowedUserIds", () => {
    expect(isAllowed("123", { ...baseConfig, allowedUserIds: [] })).toBe(false);
  });
});
```

**Verify**: `bun test` → all tests pass

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0
- [ ] `grep -n "length === 0" src/config.ts` returns no matches
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back if:

- The code at the locations in "Current state" doesn't match the excerpts.
- A step's verification fails twice.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

- The project's security model relies on `loadConfig()` rejecting empty
  whitelists. This fix makes `isAllowed` defense-in-depth consistent with
  that intent.
