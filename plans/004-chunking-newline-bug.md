# Plan 004: Fix chunking newline loss in formatLong

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d508809..HEAD -- src/bot.ts src/format.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `d508809`, 2026-06-11

## Why this matters

When a long AI response is split into Telegram-sized chunks, the newline
character at a chunk boundary can be lost. This causes paragraphs to merge
into a single line in the rendered message, degrading readability for the
most important use case — long AI-generated responses.

## Current state

The `formatLong` function (currently in `src/bot.ts:79-108`, may be in
`src/format.ts` if plan 001 ran first):

```typescript
function formatLong(text: string): string[] {
  const BUDGET = 3500;

  if (text.length <= BUDGET) {
    return [markdownToTelegramHtml(text)];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= BUDGET) {
      chunks.push(markdownToTelegramHtml(remaining));
      break;
    }

    let cutAt = remaining.lastIndexOf("\n", BUDGET);
    if (cutAt <= 0) {
      cutAt = remaining.lastIndexOf(" ", BUDGET);
    }
    if (cutAt <= 0) {
      cutAt = BUDGET;
    }

    chunks.push(markdownToTelegramHtml(remaining.slice(0, cutAt)));
    remaining = remaining.slice(cutAt);  // BUG: starts at cutAt, not cutAt+1
  }

  return chunks;
}
```

**The bug**: `remaining.slice(cutAt)` starts at the newline character
itself. So the next chunk begins with `\n`, which is a leading whitespace
that `markdownToTelegramHtml` doesn't strip. Telegram may collapse it, and
when the user reads the concatenated chunks, the paragraph break can vanish.

**The fix**: After cutting at a newline, advance past it:
`remaining.slice(cutAt + 1)`. Same for space cuts.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run typecheck`      | exit 0, no errors   |
| Tests     | `bun test`               | all pass            |

## Scope

**In scope**:
- `src/bot.ts` (or `src/format.ts` if plan 001 ran first) — fix `formatLong`

**Out of scope**:
- `markdownToTelegramHtml` (no changes needed)
- `sendResult` or `sendLong` functions
- The BUDGET constant value

## Git workflow

- Branch: `advisor/004-chunking-newline-bug`
- Commit message: `fix: preserve newlines at chunk boundaries in formatLong`
- Do NOT push or open a PR.

## Steps

### Step 1: Fix the slicing logic

In the `formatLong` function, change the two `remaining.slice(cutAt)` calls
to skip the delimiter character:

Replace:
```typescript
    chunks.push(markdownToTelegramHtml(remaining.slice(0, cutAt)));
    remaining = remaining.slice(cutAt);
```

With:
```typescript
    chunks.push(markdownToTelegramHtml(remaining.slice(0, cutAt)));
    remaining = remaining.slice(cutAt + 1);
```

This ensures:
- When cutting at `\n`: the newline stays in the first chunk as a trailing
  newline (preserving the paragraph break), and the next chunk starts with
  content, not whitespace.
- When cutting at ` `: the space stays at the end of the first chunk, and
  the next chunk starts with the next word.

**Verify**: `bun run typecheck` → exit 0

### Step 2: Verify with manual test

If plan 001's tests exist, add a test case in `src/format.test.ts`:

```typescript
test("formatLong preserves newlines at chunk boundaries", () => {
  // Create text slightly over BUDGET with a newline right at the boundary
  const line = "x".repeat(3500);
  const text = line + "\nnext paragraph";
  const chunks = formatLong(text);
  expect(chunks.length).toBe(2);
  // Second chunk should start with content, not a leading newline
  expect(chunks[1]).not.toStartWith("\n");
});
```

If tests don't exist yet, skip this step.

**Verify**: `bun test` → all tests pass

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0 (if tests exist)
- [ ] `grep -n "remaining.slice(cutAt)" src/bot.ts src/format.ts 2>/dev/null` returns no matches without `+ 1`
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back if:

- The code at the locations in "Current state" doesn't match the excerpts.
- A step's verification fails twice.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

- The BUDGET of 3500 is deliberately below Telegram's 4096 character limit
  to leave room for HTML formatting overhead.
- If the budget is changed in the future, the slicing logic remains correct
  because the fix is about delimiter handling, not the budget value.
