# Plan 011: Add Biome linter and formatter

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat d508809..HEAD -- package.json src/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `d508809`, 2026-06-11

## Why this matters

The project has no linter or formatter. Code style is maintained by convention
alone, which drifts over time and doesn't catch common bugs (unused imports,
missing awaits, loose equality). Biome is a fast, all-in-one linter+formatter
that replaces ESLint + Prettier for TypeScript projects and integrates with
the existing Bun toolchain.

## Current state

- No `.eslintrc`, `biome.json`, `.prettierrc`, or `.editorconfig` exists
- `package.json` has no `lint` or `format` script
- CI (`ci.yml`) runs only `typecheck` and `build`
- Bun is the runtime/package manager

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `bun install`            | exit 0              |
| Typecheck | `bun run typecheck`      | exit 0, no errors   |
| Tests     | `bun test`               | all pass            |
| Lint      | `bun run lint`           | exit 0 (or fixable) |

## Scope

**In scope**:
- `package.json` — add biome devDependency, `lint` and `format` scripts
- `biome.json` (create) — Biome configuration
- `src/*.ts` — fix any errors Biome flags

**Out of scope**:
- CI changes (adding lint to ci.yml — separate concern)
- Pre-commit hooks (can be added later)
- `.editorconfig` (separate file, separate plan)

## Git workflow

- Branch: `advisor/011-add-linter`
- Commit message: `chore: add Biome linter and formatter`
- Do NOT push or open a PR.

## Steps

### Step 1: Install Biome

```bash
bun add --dev @biomejs/biome
```

**Verify**: `bun run biome -- --version` → shows version

### Step 2: Initialize Biome

```bash
bun run biome -- init
```

This creates `biome.json` with defaults. Then customize it:

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": {
    "enabled": true
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "correctness": {
        "noUnusedImports": "warn",
        "noUnusedVariables": "warn"
      },
      "suspicious": {
        "noExplicitAny": "warn"
      },
      "style": {
        "noNonNullAssertion": "warn"
      }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "trailingCommas": "all"
    }
  },
  "files": {
    "ignore": ["dist", "node_modules", "*.tgz"]
  }
}
```

**Verify**: `bun run biome -- check src/` → runs without crash

### Step 3: Add scripts to package.json

Add to `package.json` scripts:
```json
"lint": "biome check src/",
"lint:fix": "biome check --write src/",
"format": "biome format --write src/"
```

**Verify**: `bun run lint` → runs (may show warnings/errors to fix)

### Step 4: Fix lint errors

Run `bun run lint:fix` to auto-fix what Biome can fix automatically.
Then check remaining issues with `bun run lint` and address them manually.

Expected issues based on code review:
- Unused imports (if any)
- `any` types in `parseJsonSafe` (use `unknown` instead of `any`)
- Possibly some formatting changes (Biome may reformat slightly differently)

Do NOT change code behavior — only fix what Biome flags. If a Biome rule
conflicts with the project's conventions, disable it in `biome.json` for
that specific case.

**Verify**: `bun run lint` → exit 0 (no errors)
**Verify**: `bun run typecheck` → exit 0 (no regressions from lint fixes)
**Verify**: `bun test` → all tests pass

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run lint` exits 0
- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0
- [ ] `biome.json` exists in project root
- [ ] `package.json` has `lint`, `lint:fix`, and `format` scripts
- [ ] `@biomejs/biome` is in devDependencies
- [ ] No files outside the in-scope list are modified
- [ ] `plans/README.md` status row updated to DONE

## STOP conditions

Stop and report back if:

- Biome installation fails or `biome init` errors.
- Biome flags more than 20 issues that require manual fixes (report the
  count and types — may need to adjust rules first).
- Auto-fix introduces type errors.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

- Biome replaces both ESLint and Prettier — don't install either alongside it.
- The `recommended` rule set is conservative. Add stricter rules incrementally.
- Future CI should add `bun run lint` to the workflow (out of scope for this plan).
- If the team later wants pre-commit hooks, `lint-staged` + `husky` or
  `lefthook` can run `biome check` on staged files.
