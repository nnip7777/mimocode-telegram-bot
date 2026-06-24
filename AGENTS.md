# Agent Instructions: mimocode-telegram-bot

This file contains high-signal project-specific context, critical toolchain quirks, and verification commands to help future AI agent sessions ramp up quickly and avoid common mistakes.

## Critical Gotchas & Environment Quirks

* **Bun PATH Resolution Issue:** The system shell environments spawned by `bun run` do not have `bun` globally in their `PATH` by default. Invoking commands like `bun run typecheck` or `bun run lint` will fail with a "bun: command not found" error.
  * **Solution:** Always prepend `export PATH="$HOME/.bun/bin:$PATH"` before executing any `bun` commands, or invoke the local Bun executable directly using `~/.bun/bin/bun`.
* **Required Environment Variables:** The bot cannot boot without a valid `.env` file containing:
  * `TELEGRAM_BOT_TOKEN`
  * `TELEGRAM_ALLOWED_USER_ID` (comma-separated whitelisted user IDs; refusing to start if empty to prevent security bypasses).

## Development Commands

All commands should have the Bun PATH prepended:

```bash
# Prep environment PATH for Bun
export PATH="$HOME/.bun/bin:$PATH"

# Run all unit tests
bun test

# Run a specific unit test file
bun test src/mimo.test.ts

# Run integration tests (Requires a live, working mimo CLI)
bun tests/integration.ts

# Run linter and formatter (Biome is used in this project)
npx @biomejs/biome check src/         # Check formatting and lint rules
npx @biomejs/biome check --write src/ # Auto-fix safe issues
npx @biomejs/biome format --write src/

# Run TypeScript typechecking
bun run typecheck

# Build the production bundle
bun run build
```

## Required Verification Order

Before claiming any task is complete, fixed, or passing, always execute this verification pipeline in order and ensure all checks pass:

1. **Lint/Format:** `npx @biomejs/biome check src/`
2. **Typecheck:** `export PATH="$HOME/.bun/bin:$PATH" && bun run typecheck`
3. **Tests:** `export PATH="$HOME/.bun/bin:$PATH" && bun test`

## Architecture & Code Boundaries

* **Single-Package App:** This is a lightweight, single-package TypeScript application.
* **Process Model:** The bot integrates with the `mimo` CLI via `spawn("mimo", ...)` processes. It streams and parses the JSON event stream from `stdout` in real-time.
* **In-Memory State:** All session, model, agent, and active process associations are maintained entirely in-memory using `Map`s inside `src/bot.ts`. There is no persistent database.
* **Resources:**
  * For architecture details, PM2 daemon configuration, command references, and flow diagrams, read `docs/USAGE.md`.
  * For historical features and design specifications of past tasks, check the files under `plans/`.
