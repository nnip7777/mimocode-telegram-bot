# Agent Instructions: mimocode-telegram-bot

## Critical Gotchas

* **Bun sub-shell PATH:** Commands spawned by `bun run` do not inherit `~/.bun/bin` in PATH. Any script that calls `bun` internally fails with "bun: command not found".
  * **Affected:** `bun run test`, `bun run typecheck` (they spawn `bun` subprocesses).
  * **Safe:** `bun run lint`, `bun run lint:fix`, `bun run format` (call `biome` directly, no PATH workaround needed).
  * **Fix:** `export PATH="$HOME/.bun/bin:$PATH"` before affected commands.

* **Required env vars (bot refuses to start without them):**
  * `TELEGRAM_BOT_TOKEN` — from @BotFather.
  * `TELEGRAM_ALLOWED_USER_ID` — comma-separated numeric Telegram user IDs. Empty value is rejected at startup (security: prevents open proxy).
  * `MIMO_SKIP_PERMISSIONS` — defaults `false`; `true` or `1` disables all agent permission prompts. Dangerous on shared hosts.

* **Workspace root:** `MIMO_WORKDIR_ROOT` (defaults to `MIMO_WORK_DIR` or cwd) is the hard boundary for `/workdir` navigation and folder creation. All filesystem paths must stay inside it.

## Commands

```bash
# Needed for commands that invoke `bun` internally:
export PATH="$HOME/.bun/bin:$PATH"

bun test                        # all unit tests
bun test src/mimo.test.ts       # single file
bun run lint                    # biome check src/
bun run lint:fix                # auto-fix safe issues
bun run format                  # biome format write
export PATH="$HOME/.bun/bin:$PATH" && bun run typecheck
export PATH="$HOME/.bun/bin:$PATH" && bun run build
bun run dev                     # watch mode
```

## Verification Order

Run in order, all must pass:

1. `bun run lint`
2. `export PATH="$HOME/.bun/bin:$PATH" && bun run typecheck`
3. `export PATH="$HOME/.bun/bin:$PATH" && bun test`

> Biome config also covers `tests/`. The `bun run lint` script only checks `src/` — run `npx @biomejs/biome check tests/` separately if test files changed.

## Integration Tests

`bun tests/integration.ts` requires a live `mimo` CLI (`npm i -g @mimo-ai/cli`). Skips cleanly if not installed.

## Architecture

* Single ESM package, entry point `src/index.ts`. No monorepo.
* Bot spawns `mimo` CLI via `child_process.spawn`, streams JSON events from stdout. All state (sessions, models, agents, running processes) is in-memory `Map`s — no database.
* `dist/` is gitignored. Build before publishing: `bun run build`.
* `work/` is gitignored scratch space.
* `docs/USAGE.md` has PM2 config, command reference, and flow diagrams. `plans/` has historical design specs.
