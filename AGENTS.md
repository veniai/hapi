<!-- cortex-managed:project:0.1.0 -->
<!-- Edit .cortex/project.md, then run cortex init. -->

# Cortex Project Source

This file is the editable source for the generated project `AGENTS.md`. Edit this file, then run `cortex init`.

## Project Facts

- **What:** HAPI — local-first platform for running AI coding agents (Claude Code, Codex, Cursor, Grok, Gemini, OpenCode) with remote control via web/phone. CLI wraps agents → hub (HTTP + Socket.IO + SSE + Telegram bot, SQLite persistence) → web PWA.
- **Layout:** Bun workspaces. `cli/` (binary, agent wrappers, runner daemon) · `hub/` (API + sockets + SSE) · `web/` (React PWA) · `shared/` (types/schemas, consumed by all three) · `docs/` (VitePress) · `website/`. Path alias `@/*` → `./src/*` per package.
- **Sources of truth:** root + package `README.md`; `shared/src/{types,schemas,socket,messages,modes}.ts`; the full pre-takeover guide is retained verbatim in Imported Instructions below.
- **Engineering rules:** no backward compatibility (break old formats freely); pragmatism over overengineering; write necessary tests only; TypeScript strict, no untyped code; prefer 4-space indentation; Zod for runtime validation (`shared/src/schemas.ts`).
- **Key patterns:** RPC — CLI registers handlers (`rpc-register`), hub routes via `rpcGateway.ts`; versioned updates (CLI sends version, hub rejects stale); session modes `local`/`remote` (switchable mid-session); permission modes `default`/`acceptEdits`/`auto`/`bypassPermissions`/`plan`; multi-user isolation via `CLI_API_TOKEN:<namespace>` suffix.
- **Data flow:** CLI spawns agent → Socket.IO → hub (DB + SSE broadcast) → web; user actions reverse via REST → RPC → CLI → agent.
- **Schema changes (hub SQLite):** versioned migrations in `hub/src/store/index.ts`, driven by `user_version` pragma, `SCHEMA_VERSION` is target. Never edit schema without a migration step — hub throws `buildSchemaMismatchError`. Full procedure in Imported Instructions.

## Native Verification

- **Commands (run from repo root):**
  - `bun typecheck` — all packages
  - `bun run test` — all packages (cli + hub + web + shared), Vitest
  - `bun run test:e2e` — Playwright e2e
- **Source/purpose:** matches `.github/workflows/test.yml`; this is the pre-push mechanical gate. Test files `*.test.ts(x)` live next to source.
- **Build artifacts:** `bun run build:web` (web dist, deploy step for web), `bun run build:single-exe` (all-in-one binary).

## Permission Envelope

- **Allowed without additional approval:** local code edits on `work/current`; side-effect-free local checks (typecheck, tests, lint) in a trusted workspace.
- **Requires approval:** anything reaching **live**. Live = systemd user services (`hapi-hub`, `hapi-web`, `hapi-runner`) running the `deploy` branch from worktree `/home/claw/deploy/hapi`; public via Cloudflare at `hapi.zhetengde.xyz`.
- **Change → live flow:**
  1. Develop on `work/current`; verify `bun typecheck && bun run test`.
  2. Move to deploy: `cd /home/claw/deploy/hapi && git merge --ff-only work/current` (or `git cherry-pick <sha>`). `--ff-only` keeps deploy a clean mirror — refuses on divergence (fix on `work/current` first), never produces merge commits.
  3. Apply by scope: web → `bun run build:web` then restart `hapi-web`; hub → restart `hapi-hub`; cli → restart `hapi-runner`; shared → restart all three. (hub/cli run source — no build.)
  4. Restarting `hapi-hub`/`hapi-runner` interrupts running agent sessions.
  5. Verify at `hapi.zhetengde.xyz` (or `localhost:3006` / `:5173`).
- **Forbidden:** committing directly on `deploy`; any merge commit on `deploy` (use `--ff-only` only); running `bun run dev` while prod occupies ports 3006/5173 (stop prod first or use alt port).

## Imported Instructions Pending Reconciliation

Full pre-takeover `AGENTS.md`, retained verbatim. Gradually fold into the structured sections above and prune duplicates as facts are confirmed by the human.

# AGENTS.md

Output style (commits/notes/summaries): telegraph; noun-phrases ok; drop grammar.

Short guide for AI agents in this repo. Prefer progressive loading: start with the root README, then package READMEs as needed.

## What is HAPI?

Local-first platform for running AI coding agents (Claude Code, Codex, Cursor, Grok, Gemini, OpenCode) with remote control via web/phone. CLI wraps agents and connects to hub; hub serves web app and handles real-time sync.

## Repo layout

```
cli/     - CLI binary, agent wrappers, runner daemon
hub/     - HTTP API + Socket.IO + SSE + Telegram bot
web/     - React PWA for remote control
shared/  - Common types, schemas, utilities
docs/    - VitePress documentation site
website/ - Marketing site
```

Bun workspaces; `shared` consumed by cli, hub, web.

## Architecture overview

```
┌─────────┐  Socket.IO   ┌─────────┐   SSE/REST   ┌─────────┐
│   CLI   │ ──────────── │   Hub   │ ──────────── │   Web   │
│ (agent) │              │ (server)│              │  (PWA)  │
└─────────┘              └─────────┘              └─────────┘
     │                        │                        │
     ├─ Wraps Claude/Codex    ├─ SQLite persistence   ├─ TanStack Query
     ├─ Socket.IO client      ├─ Session cache        ├─ SSE for updates
     └─ RPC handlers          ├─ RPC gateway          └─ assistant-ui
                              └─ Telegram bot
```

**Data flow:**
1. CLI spawns agent (claude/codex/gemini), connects to hub via Socket.IO
2. Agent events → CLI → hub (socket `message` event) → DB + SSE broadcast
3. Web subscribes to SSE `/api/events`, receives live updates
4. User actions → Web → hub REST API → RPC to CLI → agent

## Reference docs

- `README.md` - User overview, quick start
- `cli/README.md` - CLI commands, config, runner
- `hub/README.md` - Hub config, HTTP API, Socket.IO events
- `web/README.md` - Routes, components, hooks
- `docs/guide/` - User guides (installation, how-it-works, FAQ)

## Shared rules

- No backward compatibility: breaking old formats freely
- Prioritize Pragmatism, and Avoid Overengineering.
- Write necessary tests ONLY.
- TypeScript strict; no untyped code
- Bun workspaces; run `bun` commands from repo root
- Path alias `@/*` maps to `./src/*` per package
- Prefer 4-space indentation
- Zod for runtime validation (schemas in `shared/src/schemas.ts`)

## Common commands (repo root)

```bash
bun typecheck             # All packages
bun run test              # All packages (cli + hub + web + shared)
bun run test:e2e          # Playwright e2e
bun run dev               # hub + web concurrently
bun run build:web         # Web dist (deploy step for web)
bun run build:single-exe  # All-in-one binary
```

## Branches & deploy (this fork)

Live = systemd user services running **deploy branch** source from worktree `/home/claw/deploy/hapi`. Public via Cloudflare at `hapi.zhetengde.xyz`.

| service | runs | to apply a change |
|---|---|---|
| `hapi-hub` | `hub/src/index.ts` (source) | `systemctl --user restart hapi-hub` |
| `hapi-web` | built `web/dist` via `vite preview` | `bun run build:web` → `restart hapi-web` |
| `hapi-runner` | `cli/src/index.ts runner` (source) | `systemctl --user restart hapi-runner` |

Branches: `main` → tracks `upstream/main`; `deploy` → live, worktree `/home/claw/deploy/hapi`; `work/current` → scratch sandbox (no remote, safe to break; changes here do NOT reach live).

### Change → live

1. Develop on `work/current`; verify `bun typecheck && bun run test`.
2. Move to deploy: `cd /home/claw/deploy/hapi && git merge --ff-only work/current` (or `git cherry-pick <sha>`). `--ff-only` keeps deploy a clean mirror of work/current — refuses if deploy has diverged (fix it on `work/current` first), never produces merge commits. Never commit directly on `deploy`.
3. Apply by scope: web → `bun run build:web` then restart `hapi-web`; hub → restart `hapi-hub`; cli → restart `hapi-runner`; shared → restart all three. (hub/cli run source — no build needed.)
4. Restarting `hapi-hub`/`hapi-runner` interrupts running agent sessions.
5. Verify at `hapi.zhetengde.xyz` (or `localhost:3006` / `:5173`).
6. Sync upstream periodically: `git fetch upstream`; merge `upstream/main` → `main` → `deploy`.

> `bun run dev` collides with prod ports 3006/5173 — stop prod services first or use alt port.

## Key source dirs

### CLI (`cli/src/`)
- `api/` - Hub connection (Socket.IO client, auth)
- `claude/` - Claude Code integration (wrapper, hooks)
- `codex/` - Codex mode integration
- `agent/` - Multi-agent support (Gemini via ACP)
- `runner/` - Background daemon for remote spawn
- `commands/` - CLI subcommands (auth, runner, doctor)
- `modules/` - Tool implementations (ripgrep, difftastic, git)
- `ui/` - Terminal UI (Ink components)

### Hub (`hub/src/`)
- `web/routes/` - REST API endpoints
- `socket/` - Socket.IO setup
- `socket/handlers/cli/` - CLI event handlers (session, terminal, machine, RPC)
- `sync/` - Core logic (sessionCache, messageService, rpcGateway)
- `store/` - SQLite persistence (better-sqlite3)
- `sse/` - Server-Sent Events manager
- `telegram/` - Bot commands, callbacks
- `notifications/` - Push (VAPID) and Telegram notifications
- `config/` - Settings loading, token generation
- `visibility/` - Client visibility tracking

### Web (`web/src/`)
- `routes/` - TanStack Router pages
- `routes/sessions/` - Session views (chat, files, terminal)
- `components/` - Reusable UI (SessionList, SessionChat, NewSession/)
- `hooks/queries/` - TanStack Query hooks
- `hooks/mutations/` - Mutation hooks
- `hooks/useSSE.ts` - SSE subscription
- `api/client.ts` - API client wrapper

### Shared (`shared/src/`)
- `types.ts` - Core types (Session, Message, Machine)
- `schemas.ts` - Zod schemas for validation
- `socket.ts` - Socket.IO event types
- `messages.ts` - Message parsing utilities
- `modes.ts` - Permission/model mode definitions

## Pre-push self-review (agents)

Before commit/push/PR:

1. **Mechanical:** `bun typecheck && bun run test` (matches `.github/workflows/test.yml`)
2. **Logic:** skim `git diff origin/main...HEAD`; apply `.github/prompts/codex-pr-review.md` as a local Major checklist (no Codex required)
3. **Style:** optional

## Testing

- Framework: Vitest (via `bun run test`); e2e via Playwright (`bun run test:e2e`)
- Test files: `*.test.ts(x)` next to source
- Run all: `bun run test` (root); single package: `cd <pkg> && bun run test`
- Hub: `hub/src/**/*.test.ts` · CLI: `cli/src/**/*.test.ts` · Web: `web/src/**/*.test.tsx` · Shared: `shared/src/**/*.test.ts`

## Common tasks

| Task | Key files |
|------|-----------|
| Add CLI command | `cli/src/commands/`, `cli/src/index.ts` |
| Add API endpoint | `hub/src/web/routes/`, register in `hub/src/web/index.ts` |
| Add Socket.IO event | `hub/src/socket/handlers/cli/`, `shared/src/socket.ts` |
| Add web route | `web/src/routes/`, `web/src/router.tsx` |
| Add web component | `web/src/components/` |
| Modify session logic | `hub/src/sync/sessionCache.ts`, `hub/src/sync/syncEngine.ts` |
| Modify message handling | `hub/src/sync/messageService.ts` |
| Add notification type | `hub/src/notifications/` |
| Add shared type | `shared/src/types.ts`, `shared/src/schemas.ts` |

## Important patterns

- **RPC**: CLI registers handlers (`rpc-register`), hub routes requests via `rpcGateway.ts`
- **Versioned updates**: CLI sends `update-metadata`/`update-state` with version; hub rejects stale
- **Session modes**: `local` (terminal) vs `remote` (web-controlled); switchable mid-session
- **Permission modes**: `default`, `acceptEdits`, `auto`, `bypassPermissions`, `plan`
- **Namespaces**: Multi-user isolation via `CLI_API_TOKEN:<namespace>` suffix

## Schema changes (hub SQLite)

Versioned migrations in `hub/src/store/index.ts`, driven by the SQLite `user_version` pragma; `SCHEMA_VERSION` (top of that file) is the target. To change schema (e.g. add a column):

1. Add `migrateFromVNToV(N+1)` — **idempotent**: guard the `ALTER` on a column-existence check (`PRAGMA table_info`). See `migrateFromV9ToV10` for the pattern.
2. Register it in `buildStepMigrations` (`N: () => this.migrateFromVNToV(N+1)`).
3. Bump `SCHEMA_VERSION`.
4. **Also add the column in `createSchema()`** — fresh DBs skip the ladder and go straight to `createSchema`.
5. Add `migration-vN.test.ts` (see `migration-v9.test.ts`).

Never edit schema without a migration step — hub throws `buildSchemaMismatchError` on `user_version` mismatch.

## Adding new web features — consider an FUE

When you ship a non-essential feature (the 20% of sessions, not the 80%), consider wrapping its affordance in the generic First-User-Experience primitive so existing users discover it without a giant always-visible UI block.

- **Hook**: `web/src/lib/use-fue.ts` — `useFue(featureId)` returns `{ status, engage, dismiss }`. Storage namespace `hapi.fue.v1.<featureId>` (one localStorage key per feature, isolated from any upstream onboarding flow).
- **Components**: `web/src/components/Fue.tsx` — `<FueDot>` (small pulsing badge for the affordance) and `<FueCallout>` (portal-rendered popover with title/body + "Got it" affirmative-action dismiss).

Canonical example to copy (~10 lines around the affordance): `ScratchlistToggleButton` in `web/src/components/AssistantChat/ComposerButtons.tsx`.

Rules:
- Affirmative action only — no auto-timeout (reading speed varies); user dismisses via "Got it".
- FUE dot is **mutually exclusive** with any feature-specific badge (e.g. an entry counter) until acknowledged: onboarding signal beats inventory signal.
- Storage is opt-in per-feature; if upstream ships its own onboarding for a feature, just don't wrap that affordance.

## Critical Thinking

1. Fix root cause (not band-aid).
2. Unsure: read more code; if still stuck, ask w/ short options.
3. Conflicts: call out; pick safer path.
4. Unrecognized changes: assume other agent; keep going; focus your changes. If it causes issues, stop + ask user.

## Cortex Task Protocol

- Use the installed `cortex` skill for configuration reconciliation, Goal Contracts, or permission-boundary decisions.
- Prefer declared project-native verification. Local side-effect-free checks may run directly in a trusted workspace.
- A Goal cannot expand its own permission envelope. Stop and request a revised contract before new external or irreversible actions.
