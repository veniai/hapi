# 归档/删除 session 清理 worktree + 分支

> 状态：**方案（走查定稿，未实现）**。本文件描述完整版设计。
> 痛点：归档/删除 session 不清 worktree + 分支 → stale 分支 / 孤儿 worktree 堆积。

---

## 0. TL;DR

- **痛点**：归档（archive）/删除（delete）一个 worktree session 后，它的 git worktree + 分支不清理，堆积成 stale 分支 / 孤儿 worktree（实测仓库已攒一堆 `hapi-*` 残留分支）。
- **根因**：① worktree 信息（`{branch, worktreePath, basePath}`）只在 runner 内存（`run.ts` 局部），**没持久化到 session metadata**；② 归档只标 `lifecycleState=archived`（`syncEngine.archiveSession`），不碰 worktree；③ worktree 删除只在 session end（agent 进程退）时 runner 删（`git worktree remove`），**不删分支**。
- **目标**：
  - **归档** = 删 worktree + 删分支 + **留对话**（hub DB archived，可查）。
  - **删除**（前置已归档、代码已删）= 删对话（DB）。
  - 删 worktree 前**查 dirty**（未提交改动拦住，提示用户先处理，不裸丢工作）。
- **方案（4 步）**：① 持久化 worktreeInfo 到 session metadata；② 加 `CleanupWorktree` RPC（dirty check + 删 worktree + 删分支）；③ 归档 endpoint 调 RPC（dirty 拦 + 删）；④ web UI 提示。

---

## 1. 背景 / 痛点

HAPI worktree session（`sessionType: 'worktree'`）在隔离 git worktree 里跑 agent（分支 `hapi-<name>`）。用户「结束」一个 session 的两个动作：
- **归档**：活儿干完了，收起来（留对话历史，可查）。
- **删除**：彻底不要（连对话也删；UI 强制删除前必须先归档，所以走到删除时代码已被归档删干净）。

现状：归档/删除**都不清 worktree + 分支** → 每结束一个 worktree session 就残留一套（worktree 目录可能在 session end 时删了，但 git 分支永远留）。实测仓库已攒一堆 `hapi-*` stale 分支 + 孤儿 worktree 注册。

---

## 2. 现状走查（亲验 + file:line）

### 2.1 worktree 信息只在 runner 内存，没持久化

| 点 | 证据 | 现状 |
|---|---|---|
| WorktreeInfo 类型 | `cli/src/runner/worktree.ts:9-14` | `{ basePath, worktreePath, branch, name, createdAt }`，branch = `hapi-<name>`（:127） |
| createWorktree | `worktree.ts:139` `git worktree add -b hapi-<name>` | runner spawn 时建 |
| worktreeInfo 存储 | `cli/src/runner/run.ts:298` `let worktreeInfo: WorktreeInfo \| null = null` | 🔴 **局部变量，不上报 session metadata** |
| session metadata worktree 字段 | grep `shared/src/types.ts`、`hub/src/store/sessions.ts` | 🔴 **无** — hub/session 不知道 worktree 在哪 / 分支名 |

→ **归档时 hub 拿不到 worktree 信息**，任何「按 session 删 worktree」都缺信息。

### 2.2 归档只标 metadata，不碰 worktree

| 点 | 证据 | 现状 |
|---|---|---|
| archive endpoint | `hub/src/web/routes/sessions.ts:310` `POST /sessions/:id/archive` | 验 session → 调 `engine.archiveSession` |
| archiveSession | `hub/src/sync/syncEngine.ts:579` | 设 `lifecycleState='archived'` + `active=false`；🔴 **不删 worktree/分支** |

### 2.3 worktree 删除只在 session end，且不删分支

| 点 | 证据 | 现状 |
|---|---|---|
| cleanupWorktree | `cli/src/runner/run.ts:362` | runner 内存 worktreeInfo，on child exit 调 |
| 触发时机 | `run.ts:588` `happyProcess.once('exit', cleanupWorktree)` | 🔴 **只在 agent 进程退出时**（不是归档） |
| removeWorktree | `cli/src/runner/worktree.ts:165` | `git worktree remove --force`；🔴 **不删 git 分支** |

→ session end 删了 worktree 目录，但**分支留着**（stale 分支来源）。

### 2.4 删除 endpoint（只删 DB，要求已 inactive）

| 点 | 证据 | 现状 |
|---|---|---|
| delete endpoint | `sessions.ts:656` `DELETE /sessions/:id` | if active → 409「Cannot delete active session. Archive it first.」；else `engine.deleteSession` 删 DB |
| 删 worktree? | — | 🔴 **不删**（只删 DB 记录） |

---

## 3. 根因

两个独立缺陷：
1. **worktreeInfo 不持久化**：hub 不知道 session 的 worktree 在哪，任何「按 session 删 worktree」都缺信息。
2. **清理不彻底**：即使删 worktree（session end），分支不删；归档/删除根本不触发清理。

---

## 4. 方案（完整版，4 步）

### 4.1 持久化 worktreeInfo 到 session metadata（前提）

runner createWorktree 后，把 `{worktreePath, branch, basePath}` 上报到 session metadata（走现成 update-metadata，`cli/src/runner/run.ts` + `apiSession`）。hub 存 `session.metadata.worktree`。

- session metadata 是 freeform JSON，加 `worktree` 子字段**不需 DB schema migration**（metadata 列是 JSON）。
- `shared/src/types.ts` Session metadata 类型加 `worktree?: { worktreePath: string; branch: string; basePath: string }`（TS 类型）。

### 4.2 加 `CleanupWorktree` RPC（cli + hub）

**cli 侧**（registerHandler，照 `cli/src/api/apiMachine.ts` 模式）：
- `RPC_METHODS.CleanupWorktree`：收 `{ worktreePath, branch, basePath }`。
- 逻辑：
  1. `git -C worktreePath status --porcelain` → 非空（dirty）→ 返回 `{ ok: false, dirty: true, files: [...] }`。
  2. 干净 → `removeWorktree`（`git worktree remove`）+ `git branch -D branch`（删分支，改进）→ 返回 `{ ok: true }`。

**hub 侧**（`hub/src/sync/rpcGateway.ts`，照 `killSession:137` 模式）：
- `cleanupWorktree(sessionId)`：读 `session.metadata.worktree` → `machineRpc` 调 cli `CleanupWorktree`。

### 4.3 归档 endpoint 改造（`sessions.ts:310` archive）

archive handler：
1. if `session.metadata.worktree` 存在（worktree session）→ 调 `engine.cleanupWorktree(sessionId)`：
   - dirty → 返回 409「worktree 有 N 个未提交改动，先处理」（**不归档**）。
   - ok → worktree + 分支已删，继续。
   - runner 离线（RPC 不可达）→ 见 §6.1 选项。
2. `engine.archiveSession`（标 archived + active=false）。

### 4.4 删除 endpoint（`sessions.ts:656` delete）— 不变

UI 强制「删除前必须先归档」，归档（4.3）已删 worktree + 分支，所以删除只删 DB 对话（现状 `deleteSession`）。**不改**。

### 4.5 web UI

归档按钮点下去 → backend 返回 dirty 409 → 弹提示「这个 session 的 worktree 有未提交改动，先去处理（commit 或丢弃）再归档」。

---

## 5. 改动清单

| 文件 | 改动 |
|---|---|
| `cli/src/runner/run.ts` | createWorktree 后 update-metadata 上报 `{worktreePath, branch, basePath}` |
| `cli/src/runner/worktree.ts` | 加 `cleanupWorktreeAndBranch`（git status dirty + removeWorktree + `git branch -D`） |
| `cli/src/api/`（session/machine RPC 注册处） | register `RPC_METHODS.CleanupWorktree` handler |
| `shared/src/socket.ts` + `types.ts` | 加 `CleanupWorktree` RPC method + 请求/响应类型 + Session metadata `worktree?` 字段 |
| `hub/src/sync/rpcGateway.ts` | 加 `cleanupWorktree(sessionId)`（读 metadata.worktree → machineRpc） |
| `hub/src/sync/syncEngine.ts` | 加 `cleanupWorktree`（调 rpcGateway） |
| `hub/src/web/routes/sessions.ts:310` | archive handler：metadata.worktree 存在 → cleanupWorktree（dirty 拦 + 删）→ archiveSession |
| `web/src/...` | 归档 dirty 409 响应 → 弹提示 |

**不改**：DB schema（metadata JSON 列）、删除 endpoint（仍删 DB）。

---

## 6. 复杂点 / 待定选项

### 6.1 runner 离线（machine 没连）怎么办

归档时 RPC 发不到 runner → worktree 删不了。两选：
- **a. 标「待清理」**（倾向）：归档照常（标 archived），worktree 记 pending-cleanup；runner 重连时补删。不阻塞用户归档。
- **b. 拒绝归档**：409「机器离线，先连 runner 再归档」。

### 6.2 dirty 检查边界

- `git status --porcelain` 非空 = dirty。untracked 文件算（倾向，untracked 也是未提交）。
- 拦住后用户怎么「处理」：进 worktree commit、或手动 discard。UI 提示 + 引导。

### 6.3 非 worktree session（sessionType 非 worktree）

非 worktree session（普通目录）归档不涉 worktree，跳过清理（现状不变）。

---

## 7. 验证（实施时）

- worktree session 归档 → worktree 删 + 分支删（`git branch` 无残留）+ 对话留（archived 可查）。
- 归档时 worktree dirty → 409 + 提示（不删）。
- 非 worktree session 归档 → 不变。
- runner 离线归档 → 标 pending（6.1a）或拒（6.1b），待定。
- 删除（已归档）→ 只删对话（代码已删）。

---

## 8. 简化版（out of scope，对比）

简化版只改 session end 的 `cleanupWorktree` 加 `git branch -D`（agent 退时连 worktree 带分支删）。不需持久化 / RPC / endpoint 改。但「end 时清」≠「归档时清」（归档时 agent 还活则删不了，得等它退）。本 spec 选完整版（归档即清），简化版作为 fallback / 第一步。
