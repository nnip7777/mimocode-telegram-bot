# Plan 009: Extract shared message handler pattern

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
- **Effort**: M
- **Risk**: MED
- **Depends on**: plan 001 (tests must exist before refactoring)
- **Category**: tech-debt
- **Planned at**: commit `d508809`, 2026-06-11

## Why this matters

Three handlers in `bot.ts` — `/compose`, `/max`, and the `message:text`
handler — share nearly identical logic: check auth → check processing →
add to processing → send placeholder → call mimo → send result → catch
errors → finally remove from processing. Bugs fixed in one handler can be
missed in others (already happened: compose/max log timing, text handler
doesn't). Extracting the shared pattern eliminates this class of bug.

## Current state

File: `src/bot.ts`

The three handlers follow this pattern (shown for `/compose`, lines 374-413):

```typescript
bot.command("compose", async (ctx) => {
  if (!checkAuth(ctx, config)) return;          // 1. Auth
  const chatId = String(ctx.chat.id);
  const text = ctx.match?.trim();

  if (!text) { /* usage message */ return; }    // 2. Parse input

  if (processing.has(chatId)) {                 // 3. Prevent concurrent
    await ctx.reply("Task running. Wait or /cancel.");
    return;
  }

  processing.add(chatId);                       // 4. Mark processing
  const startTime = Date.now();

  try {
    const sent = await ctx.reply("⏳ ...");     // 5. Placeholder
    const result = await mimo.sendMessage(chatId, text, { agent: "compose" });  // 6. Call mimo

    if (!result.content) {                      // 7. Handle empty
      await bot.api.editMessageText(chatId, sent.message_id, "(empty)").catch(() => {});
      return;
    }

    await sendResult(chatId, sent.message_id, result.content);  // 8. Send result
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${new Date().toISOString()}] compose chat=${chatId} time=${elapsed}s`);
  } catch (err) {                               // 9. Handle error
    const msg = err instanceof Error ? err.message : String(err);
    try { await ctx.reply(`Error: ${msg}`); } catch {}
  } finally {                                   // 10. Cleanup
    processing.delete(chatId);
  }
});
```

The `/max` handler (lines 416-453) is identical except for the placeholder
text ("⚡ Max mode...") and the `sendMessage` options (`{ variant: "max" }`).

The `message:text` handler (lines 574-625) adds session-switching logic
at the top but the mimo-call section is the same pattern.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `bun run typecheck`      | exit 0, no errors   |
| Tests     | `bun test`               | all pass            |

## Scope

**In scope**:
- `src/bot.ts` — extract shared handler into a helper function, refactor
  the three handlers to use it

**Out of scope**:
- `src/mimo.ts` — no changes
- `src/format.ts` — no changes
- Changing the session-switching logic in `message:text`
- Changing the auth check logic
- Adding new commands

## Git workflow

- Branch: `advisor/009-extract-handler-pattern`
- Commit message: `refactor: extract shared mimo command handler pattern`
- Do NOT push or open a PR.

## Steps

### Step 1: Create the shared handler function

In `src/bot.ts`, add a helper function inside `createBot` (after `sendLong`):

```typescript
type MimoRunOpts = {
  placeholder: string;
  logPrefix: string;
  mimoOpts?: import("./mimo.js").SendMessageOpts;
};

async function runMimoCommand(
  ctx: { from?: { id: number }; chat: { id: number }; reply: (text: string, opts?: Record<string, unknown>) => Promise<import("grammy").Message> },
  text: string,
  opts: MimoRunOpts,
) {
  const chatId = String(ctx.chat.id);

  if (processing.has(chatId)) {
    await ctx.reply("Task running. Wait or /cancel.");
    return;
  }

  processing.add(chatId);
  const startTime = Date.now();

  try {
    const sent = await ctx.reply(opts.placeholder);
    const result = await mimo.sendMessage(chatId, text, opts.mimoOpts);

    if (!result.content) {
      await bot.api.editMessageText(chatId, sent.message_id, "(empty)").catch(() => {});
      return;
    }

    await sendResult(chatId, sent.message_id, result.content);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${new Date().toISOString()}] ${opts.logPrefix} chat=${chatId} time=${elapsed}s`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try { await ctx.reply(`Error: ${msg}`); } catch {}
  } finally {
    processing.delete(chatId);
  }
}
```

**Verify**: `bun run typecheck` → exit 0

### Step 2: Refactor /compose handler

Replace the `/compose` handler body:

```typescript
bot.command("compose", async (ctx) => {
  if (!checkAuth(ctx, config)) return;
  const text = ctx.match?.trim();
  if (!text) {
    await ctx.reply("Usage: /compose <your idea>\n\nRuns: plan → code → test → review");
    return;
  }
  await runMimoCommand(ctx, text, { placeholder: "⏳ Compose: plan → code → test → review...", logPrefix: "compose", mimoOpts: { agent: "compose" } });
});
```

**Verify**: `bun run typecheck` → exit 0

### Step 3: Refactor /max handler

Replace the `/max` handler body:

```typescript
bot.command("max", async (ctx) => {
  if (!checkAuth(ctx, config)) return;
  const text = ctx.match?.trim();
  if (!text) {
    await ctx.reply("Usage: /max <complex task>");
    return;
  }
  await runMimoCommand(ctx, text, { placeholder: "⚡ Max mode...", logPrefix: "max", mimoOpts: { variant: "max" } });
});
```

**Verify**: `bun run typecheck` → exit 0

### Step 4: Refactor message:text handler's mimo-call section

Replace the mimo-call section in the `message:text` handler (lines 597-624):

```typescript
  // Keep the session-switch logic above this (lines 585-595)

  await runMimoCommand(ctx, text, { placeholder: "...", logPrefix: "chat" });
});
```

Remove the duplicated `processing.add`, `startTime`, `try/catch/finally`
block from the text handler.

**Verify**: `bun run typecheck` → exit 0

### Step 5: Verify all handlers work

**Verify**:
- `bun run typecheck` → exit 0
- `bun test` → all tests pass
- `grep -c "runMimoCommand" src/bot.ts` → 3 (three callers)
- The `processing`, `sendResult`, `bot.api`, `mimo.sendMessage` are no
  longer duplicated across handlers

## Test plan

If plan 001's tests exist:
- Verify existing tests still pass (they test the helper functions, not
  the handlers directly, but a regression here would indicate a real issue)
- No new unit tests needed — this is a structural refactor with identical
  behavior. The test is that `bun test` still passes.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0
- [ ] `grep -c "runMimoCommand" src/bot.ts` → exactly 3
- [ ] `grep -c "processing.add" src/bot.ts` → exactly 1 (inside runMimoCommand)
- [ ] `grep -c "processing.delete" src/bot.ts` → exactly 1 (inside runMimoCommand)
- [ ] The session-switch logic in `message:text` handler is preserved
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back if:

- The code at the locations in "Current state" doesn't match the excerpts.
- A step's verification fails twice.
- The fix appears to require touching an out-of-scope file.
- The `ctx` type ingrammY handlers doesn't match the type annotation in
  `runMimoCommand` (grammY has complex context types — use the actual type
  from the handler's parameter, not a simplified one).

## Maintenance notes

- New command handlers that call `mimo run` should use `runMimoCommand`
  instead of duplicating the pattern.
- The `MimoRunOpts` type can be extended with new options as needed.
- The `ctx` type in `runMimoCommand` should match grammymy's actual context
  type — if the typecheck complains, use `Parameters<Parameters<typeof bot.command>[1]>[0]`
  or import grammymy's Context type directly.
