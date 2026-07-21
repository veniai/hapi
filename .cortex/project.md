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
  - `bun run build:web` — web dist; **local / pre-promotion gate**（typecheck/test 过 ≠ 能 build）。**GitHub CI gate 待实现**（`test.yml` 当前只 install+typecheck+test，不跑 build）。
  - `bun run test:e2e` — Playwright e2e (slow; not in default gate)
- **cli test caveat:** `cli/src/runner/runner.integration.test.ts` writes the real `cli/package.json` (auto-restored in `finally`, but not under SIGKILL/timeout). **Deploy-host full gate =** `(cd cli && bun run tools:unpack && bunx vitest run --exclude '**/*.integration.test.ts') && bun run test:hub && bun run test:web && bun run test:shared`（exclude cli integration，keep hub/web/shared；用 bunx 因 deploy job PATH 不含 node_modules/.bin）。
- **Source/purpose:** pre-push mechanical gate（typecheck+test 对应 `test.yml`；build:web 是本地/部署门，未进 GitHub CI）。Test files `*.test.ts(x)` live next to source.
- **Build artifacts:** `bun run build:single-exe` (all-in-one binary, release only).

## Permission Envelope

- **Allowed without additional approval:** local code edits on feature branches off `main`; side-effect-free local checks (typecheck, tests, lint) in a trusted workspace.
- **Requires approval:** anything reaching **live** **unless covered by the standing authorization below**. Live = systemd user services (`hapi-hub`, `hapi-web`, `hapi-runner`) running the `deploy` branch from worktree `/home/claw/deploy/hapi`; public via Cloudflare at `hapi.zhetengde.xyz`.
- **Change → live flow:**
  1. Branch off `main` (`feature/<name>`); develop + verify `bun typecheck && bun run test`.
  2. Push feature branch + open PR → `main`. CI gate (`.github/workflows/test.yml`: typecheck + test + build:web) must pass; **branch protection** requires the `test` check + linear history (merge rebase, no merge commit). Delete branch after merge.
  3. After merge, move to deploy: `cd /home/claw/deploy/hapi && git merge --ff-only main`. `--ff-only` keeps deploy a clean mirror of `main` — refuses on divergence (fix on a new PR first), never produces merge commits.
  4. Apply by scope: web → `bun run build:web` then restart `hapi-web`; hub → restart `hapi-hub`; cli → restart `hapi-runner`; shared → restart all three. (hub/cli run source — no build.)
  5. Restarting `hapi-hub`/`hapi-runner` interrupts running agent sessions.
  6. Verify at `hapi.zhetengde.xyz` (or `localhost:3006` / `:5173`).
- **Forbidden:** committing directly on `deploy` or `main` (use PRs); any merge commit on `deploy`/`main` (branch protection enforces linear history); running `bun run dev` while prod occupies ports 3006/5173 (stop prod first or use alt port).
- **Standing Authorization（用户授予，直到撤销；常规部署 auto 的权限来源）：**
  - **授权：** Routine 部署的 Goal B —— restart + 验证 + Routine 回滚（reset 到 last-good SHA + restart，**无 DB restore**）。
  - **触发（机械验，全满足才 auto）：** CI 过 + promotion SHA == deploy HEAD + 非 migration（`SCHEMA_VERSION` 数值未变，判定 fail-closed，见下）。
  - **不授权（仍人批）：** migration 部署 + DB restore（丢数据）+ 超 K/L 上限。
  - **撤销：** 改本节 → `cortex init`。
  - 注：本 standing authorization 是**用户预授予**，非 Goal 自授（Cortex 红线：Goal 不能自扩权）。
- **High-risk deploy = two-phase, branched authorization (Cortex permission envelope):**
  - **Goal A (prepare):** build + capture baseline (commit SHA + `user_version`) + rollback plan + **DB snapshot**（**SQLite backup API**：`sqlite3 ~/.hapi/hapi.db ".backup ~/.hapi/hapi.db.pre-deploy-<run-id>"` 或 bun:sqlite backup——**非 cp**：hub 用 WAL，cp 主 db 漏 `-wal` 事务；快照后 `PRAGMA integrity_check` + 读 `user_version` 验证可恢复；run-id 安全字符集 + 独占创建 + 拒 symlink）。
  - **Migration 判定（fail-closed）：** 比较 last-good SHA 与 immutable target SHA 中 `hub/src/store/index.ts` 的 `SCHEMA_VERSION` 数值；**无法解析 / 值变化 / deploy HEAD 漂移 → 一律进 Migration（停，不 auto）**。restart 前再验 `deploy HEAD == authorized target SHA`。
  - **Authorization branches（状态机，互斥）:**
    - **Routine（非 migration）:** Goal A 完成 + 判定非 migration → `authorized-by-standing-authorization`（机械验 CI 过 + SHA 匹配，**权限来源 = 上方 Standing Authorization，非 Goal 自授**）→ **直接 Goal B，无人 gate**。
    - **Migration:** Goal A 完成 → `ready-for-approval` → **人显式 grant** → Goal B。
  - **Goal B（execute）+ rollback（拆）:** `systemctl restart` + verify（`/health` + readiness + commit 校验）。Health check 是**证据，非批准**。验证失败回滚**拆**：
    - **Routine 回滚**（schema 未变）：`git reset` 到 last-good SHA + restart（**无 DB restore**——DB 没动）。Standing auth 预授权。
    - **DB restore**（migration 失败 / schema 变）：进 `rollback-ready-for-approval`（展示快照 + 当前 DB + 写入时间窗 + 预计丢失）→ **人 grant 后执行**（丢数据，必须人批）。

## Agent Dev Loop (后半执行循环)

> 详见 `doc/spec/agent-dev-loop.md`（设计稿 v2，Codex 审过）。Cortex 提供框架（Goal Contract / permission envelope / 原生验证声明）；循环执行靠 agent + `hapi-deploy-run`。

单循环（一个 agent 循环贯穿 CI + 部署 + live 验证，失败回改）：
- **本地验证门**：typecheck + test + build:web（feature 分支本地跑，PR CI 同门复跑）。
- **promotion**：PR merge → `main` → `git merge --ff-only main` → deploy worktree；**live SHA 必须等于 CI 过的 SHA**。
- **部署门**：准备（build + DB 快照 + 基线）→ 授权（envelope / 人批 migration）→ restart → 验证（`/health` + readiness + commit 校验）。
- **失败回滚**：三路径（代码失败 / 部分迁移 / 迁移后失败），DB 快照为基础；先回滚保 live，再回改，**不在坏 live 上循环**。
- **计数**：run ID + attempt ≤ K=8 / redeploy ≤ L=3，执行器强制 + 持久化（跨会话恢复）。**agent 目标任务生成 run-id，经 `HAPI_DEPLOY_RUN_ID=<run-id> hapi-deploy` 传入，跨 attempt 复用**（state: `~/.hapi/deploy-runs/<run-id>.json`）；超限 `hapi-deploy-run` 拒 + 钉钉叫人。
- **收尾**：Finish 报告（达成 + 外部证据 + 未决不确定 + 未越边界）→ **human-accepted**（显式状态）→ 洁癖（规约端 reconcile + 代码/记忆端 agent 配合）→ 清理（消费 human-accepted）。

**状态（诚实）：** 循环规约 = 设计稿定稿；执行器 `hapi-deploy-run` 现状 = `bun install + typecheck + build:web + systemctl restart + web / + hub /api/sessions(401)`，**无 test、未用 `/health`/readiness/commit 探针、无回滚/通知/计数/DB 快照/promotion SHA 绑定**（见 `agent-dev-loop.md` §8）。落地前再让 Codex 复审。

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

Branches: `main` → tracks `upstream/main`, PR target, **branch-protected** (required `test` check + linear history — no merge without green CI); `deploy` → live, worktree `/home/claw/deploy/hapi`; `feature/<name>` → short-lived, off `main`, one per PR, deleted post-merge. No `work/current` scratch branch — everything flows through PRs to `main`.

### Change → live

1. Branch off `main` (`feature/<name>`); develop + verify `bun typecheck && bun run test`.
2. Push feature branch + open PR → `main`. CI (`.github/workflows/test.yml`: typecheck + test + build:web) must pass; branch protection requires the `test` check + linear history (merge rebase, never a merge commit). Delete branch after merge.
3. Move to deploy: `cd /home/claw/deploy/hapi && git merge --ff-only main`. `--ff-only` keeps deploy a clean mirror of `main` — refuses if deploy has diverged (fix on a new PR first), never produces merge commits. Never commit directly on `deploy`.
4. Apply by scope: web → `bun run build:web` then restart `hapi-web`; hub → restart `hapi-hub`; cli → restart `hapi-runner`; shared → restart all three. (hub/cli run source — no build needed.)
5. Restarting `hapi-hub`/`hapi-runner` interrupts running agent sessions.
6. Verify at `hapi.zhetengde.xyz` (or `localhost:3006` / `:5173`).
7. Sync upstream periodically: `git fetch upstream`; merge `upstream/main` → `main` (via PR) → `deploy`.

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
- `store/` - SQLite persistence (bun:sqlite)
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
