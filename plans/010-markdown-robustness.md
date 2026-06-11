# Plan 010: Improve markdown-to-HTML converter robustness

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

- **Priority**: P3
- **Effort**: M
- **Risk**: MED
- **Depends on**: plan 001 (tests must exist before changing parser)
- **Category**: tech-debt
- **Planned at**: commit `d508809`, 2026-06-11

## Why this matters

The regex-based markdown-to-HTML converter handles common cases but fails
silently on edge cases common in AI output: unclosed code fences, nested
formatting, and malformed markdown. When it produces invalid HTML, the
Telegram API rejects it, and the fallback at `bot.ts:138` sends raw text
— losing all formatting. Robustness improvements reduce how often this
fallback triggers.

## Current state

File: `src/format.ts` (or `src/bot.ts` if plan 001 hasn't run yet)

The `markdownToTelegramHtml` function handles:
- Code blocks (fenced) ✓
- Inline code ✓
- Headings → bold ✓
- Bold/italic/strikethrough ✓
- Links ✓
- Lists ✓
- Blockquotes → plain text ✓

**Known edge cases** (not handled):
1. Unclosed code fences (AI sometimes generates ` ``` ` without closing) —
   the regex `[\s\S]*?` matches greedily, consuming the rest of the text
2. Nested bold inside italic or vice versa — regex ordering matters
3. `escapeHtml` is called before formatting conversion, so the replacement
   patterns for bold/italic use the literal `**` / `_` markers (which is
   correct) — but the ordering means some valid markdown is silently dropped
4. No handling of task lists (`- [ ]` / `- [x]`)

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run typecheck`      | exit 0, no errors   |
| Tests     | `bun test`               | all pass            |

## Scope

**In scope**:
- `src/format.ts` (or `src/bot.ts`) — harden `markdownToTelegramHtml`

**Out of scope**:
- Full markdown parser library (overkill for this use case)
- Changes to `formatLong` or `wrapCode`
- Changes to `sendResult` or the HTML parse_mode fallback
- Telegram-specific escaping (handled by grammY/bot API)

## Git workflow

- Branch: `advisor/010-markdown-robustness`
- Commit message: `fix: handle edge cases in markdown-to-HTML converter`
- Do NOT push or open a PR.

## Steps

### Step 1: Fix unclosed code fences

The current code block regex is:
```typescript
text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code: string) => {
```

If the AI output has an opening ` ``` ` without a closing one, `[\s\S]*?`
still matches because it's lazy and looks for the *next* ` ``` ` — but
there is none, so it matches nothing (the `?` makes it try the shortest
match first, which is zero characters). This means the opening ` ``` `
stays in the text and gets HTML-escaped, producing visible ` ``` ` in
the output.

Fix: add a fallback for unclosed code blocks at the end of the function:

After all existing processing, before the return:
```typescript
// Handle unclosed code fence: if any ``` remains (wasn't consumed above),
// treat everything from that point as a code block.
const unclosedFence = text.indexOf("```");
if (unclosedFence !== -1) {
  const before = text.slice(0, unclosedFence);
  const codeContent = text.slice(unclosedFence + 3).replace(/\n$/, "");
  return before + `<pre><code>${escapeHtml(codeContent)}</code></pre>`;
}
```

**Verify**: `bun run typecheck` → exit 0

### Step 2: Add task list support

AI outputs often include `- [ ] task` and `- [x] done` patterns. Convert
them to readable HTML:

Add after the existing list conversion:
```typescript
text = text.replace(/^[-*]\s+\[x\]\s+/gm, "✅ ");
text = text.replace(/^[-*]\s+\[ \]\s+/gm, "⬜ ");
```

**Verify**: `bun run typecheck` → exit 0

### Step 3: Handle horizontal rules

Add after list conversions:
```typescript
text = text.replace(/^[-*_]{3,}\s*$/gm, "―");
```

**Verify**: `bun run typecheck` → exit 0

### Step 4: Add tests for edge cases

If plan 001's test infrastructure exists, add tests in `src/format.test.ts`:

```typescript
test("markdownToTelegramHtml handles unclosed code fence", () => {
  const input = "Here is code:\n```python\nprint('hello')\n";
  const result = markdownToTelegramHtml(input);
  expect(result).toContain("<pre><code>");
  expect(result).toContain("print(&amp;#39;hello&amp;#39;"); // HTML-escaped
  expect(result).toContain("</code></pre>");
});

test("markdownToTelegramHtml handles task lists", () => {
  const input = "- [x] Done\n- [ ] Todo";
  const result = markdownToTelegramHtml(input);
  expect(result).toContain("✅");
  expect(result).toContain("⬜");
});

test("markdownToTelegramHtml handles horizontal rules", () => {
  const input = "Before\n---\nAfter";
  const result = markdownToTelegramHtml(input);
  expect(result).toContain("―");
});
```

**Verify**: `bun test` → all tests pass

### Step 5: Verify

**Verify**:
- `bun run typecheck` → exit 0
- `bun test` → all tests pass
- Existing markdown conversion tests still pass

## Test plan

Already included in step 4. Expected new tests: 3-4 edge case tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0
- [ ] Tests for unclosed code fence, task lists, and horizontal rules exist
- [ ] Existing `markdownToTelegramHtml` tests still pass
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back if:

- The code at the locations in "Current state" doesn't match the excerpts.
- A step's verification fails twice.
- The fix appears to require touching an out-of-scope file.
- The unclosed fence fix changes behavior for already-closed code fences
  (regression). If the indexOf("```") check triggers on valid text with
  closed fences, the approach needs adjustment.

## Maintenance notes

- The markdown converter is intentionally simple — it handles the common
  subset of markdown that AI models produce. Don't try to make it a full
  parser.
- The unclosed fence fix is a heuristic: it assumes anything after the
  last unmatched ` ``` ` is code. This is usually correct for AI output.
- If the converter is extended further, consider switching to a proper
  markdown-to-HTML library (like `marked`) with a custom renderer that
  outputs Telegram-compatible HTML. That's a larger effort, out of scope
  for this plan.
