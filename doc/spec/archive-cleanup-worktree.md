# 归档 Worktree Session 的安全清理

> 状态：**已实现，验证进行中**。本文是本次 `/goal` 的实现与验证依据；范围仅覆盖本地代码、测试和隔离浏览器验证，不部署，也不清理既有 worktree。

## 1. 需求、边界与授权

### 1.1 目标

对 HAPI 管理的 worktree session，用户点击「归档」时提供单一、可预期的结果：

- **成功**：结束 session，删除该 Git worktree 和分支，保留已归档的对话。
- **无问题**：直接归档，不显示额外确认弹窗。
- **被阻止**：仅在发现 blocker 时弹窗告知原因，并询问是否继续归档。取消则不改变任何状态；继续则执行明确的强制路径。

这解决 worktree 与 `hapi-*` 分支持续堆积的问题，同时不静默丢弃未提交或未合并的成果。

### 1.2 用户可见规则

归档 worktree session 前，以下任一条件成立都必须先阻止正常路径并弹出明确原因：

1. 对应 runner / machine 不在线，无法在本机完成检查和清理。
2. agent 仍在执行或存在后台任务，无法安全停止和检查。
3. worktree 有 staged、unstaged 或 untracked 文件。
4. 分支含有相对创建基线尚未合并的 commit。
5. metadata、Git worktree 注册、路径或分支的归属无法相互验证。
6. Git 检查、停止 session、删除 worktree 或删除分支任一步失败。

通过检查时，归档直接完成。发现 blocker 后，用户可以选择继续：

- dirty 或未合并提交：继续表示用户明确接受丢弃本地成果；runner 使用强制 worktree/branch 清理。
- runner 离线、归属无法验证或 Git 无法安全定位：继续只归档对话，不猜测路径、不删除目录，并在 blocker 文案中说明 worktree 会保留。
- session 忙、停止失败或其他无法确认安全删除的情况：继续只归档对话；若 runner 可达则先尝试停止，清理失败不再重试。

系统不创建 `pending-cleanup`、不后台重试，也不在用户未明确点击继续时丢弃本地成果。

「删除 session」只能删除已经成功归档的对话记录；它不提供绕过上述检查来删除本地代码的路径。

### 1.3 范围

- 适用：由 HAPI 创建、metadata 与 Git 注册均可验证的 Git worktree session。
- 不适用：普通 session；它们的归档行为保持不变。
- Cursor 原生 worktree：仅在能以 Cursor/Git 元数据证明同一性时纳入；无法证明时作为 blocker，而不是猜测路径或分支。
- 旧 session：缺少创建基线或归属信息时作为 blocker，要求用户手动处理，不对历史目录作批量推断或删除。

### 1.4 权限与停点

后续代码实现会引入受用户二次点击「继续归档」触发的本地强制清理。普通路径仍使用非强制 Git 操作；只有用户明确接受 dirty/未合并成果时，才允许使用 `git worktree remove --force` 与 `git branch -D`。不涉及数据库 migration、生产部署或现有 worktree 的自动清扫。

本次实现已在用户确认交互和强制后果后执行。若后续发现无法可靠判定分支是否已合并、无法验证 Cursor 原生 worktree 的归属，仍按 archive-only blocker 处理，不放宽检查。

## 2. 调研发现

### 2.1 已有信息与现状

| 事实 | 证据 | 影响 |
| --- | --- | --- |
| `Metadata` 已有 `worktree` 字段 | `shared/src/schemas.ts` 的 `WorktreeMetadataSchema` | 原设计所称“metadata 无 worktree 字段”已过时；无需为此做 DB migration。 |
| HAPI runner 创建 worktree 后通过环境变量传给 session；session 工厂会写入 metadata | `cli/src/runner/run.ts`、`cli/src/utils/worktreeEnv.ts`、`cli/src/agent/sessionFactory.ts` | 常规 HAPI worktree session 已具备基础关联信息。 |
| Cursor ACP 也会写入 `metadata.worktree` | `cli/src/cursor/cursorAcpRemoteLauncher.ts` | 不能假设所有 worktree 都是同一创建器或都可按 `hapi-*` 规则删除。 |
| 当前归档调用 `KillSession` 后立即标 session inactive | `hub/src/sync/syncEngine.ts` 的 `archiveSession` | 新流程不应在 agent 仍可能写目录时直接删除 worktree。 |
| 当前正常 child exit 没有统一触发 worktree 清理；timeout 路径才注册清理 listener | `cli/src/runner/run.ts` | worktree 确实会残留；原 Spec 对“每次 session end 都会删除 worktree”的描述不准确。 |
| 当前删除函数使用 `git worktree remove --force` | `cli/src/runner/worktree.ts` | 普通归档路径不得强制删除；仅用户明确继续且归属已验证时允许 force。 |
| 删除 API 仅检查 inactive，未验证 archived | `hub/src/web/routes/sessions.ts` | 后续必须使服务端也强制“先成功归档”。 |

本地只读抽样显示当前仓库有多个同级 worktree 与 `hapi-*` 分支；这证明积累现象存在，但分支数量本身不能区分仍在使用和 stale 的条目。

### 2.2 关键安全判断

`git status --porcelain` 为空只说明没有未提交文件，**不代表分支没有未合并的提交**。因此“干净即 `git branch -D`”会删除已 commit 但未合并的成果，不符合目标。

新建 worktree 必须记录创建时的基线 ref 和 commit。归档检查需要证明该 worktree 分支已被合并到该基线；无法证明即阻止，而不是根据当前默认分支或分支名前缀猜测。

## 3. 设计契约

### 3.1 归档事务

归档 API 对用户表现为一次操作：成功才变为 archived，失败即时返回 blocker。内部必须按以下不变量组织：

1. 先在 runner 所在机器做只读预检；预检失败不终止 session。
2. 预检通过后停止 agent，并在其不再写入 worktree 后进行最终复检。
3. 最终复检通过后，以非强制 Git 操作删除 worktree 与分支；用户选择 dirty/未合并强制路径时，改用明确授权的强制删除。
4. 只有本地删除均确认成功，Hub 才将普通路径写为 archived。用户选择强制路径时，即使清理被安全边界跳过，也会写为 archived，并保留 blocker 文案说明。

最终复检是防竞态所必需的：agent 可能在首次预检后写入文件。若最终复检失败，返回 blocker，保留 worktree 与分支，并保持对话未归档；agent 已停止这一事实必须在 UI 错误信息中明确说明，用户处理后可重新归档。

### 3.2 归属与合并证明

清理请求不得把来自 UI 或 metadata 的路径、分支名直接交给 Git 删除。runner 必须验证：

- `basePath` 是仓库根目录；
- `worktreePath` 是该仓库当前注册的 worktree；
- worktree 当前分支与 metadata 以及创建记录一致；
- 创建记录中的基线 ref 仍可解析；
- worktree 分支已可达于该基线 ref，因而没有该 session 独有的未合并 commit。

任一验证失败都是 blocker。删除分支使用已验证的 Git ref，不用字符串拼接或 `hapi-*` 前缀作为授权依据。

### 3.3 Blocker 响应

服务端返回稳定的结构化 blocker code 与人可读说明。至少涵盖：`machine_offline`、`session_busy`、`dirty_worktree`、`unmerged_commits`、`worktree_unverified`、`git_failure`、`stop_failure`。

Web 正常路径不显示归档确认框。服务端返回 blocker 时，Web 才显示包含原因和后果的二次确认框；取消保持 session 未归档，继续按 blocker 类型执行强制路径。强制路径成功后不再显示“已归档”提示弹窗，由列表状态刷新体现结果。

### 3.4 数据与兼容边界

- worktree metadata 增加基线证明所需字段；这是 JSON metadata 的协议演进，不需要 SQLite schema migration。
- 现有 metadata 缺少这些字段时不做兼容性猜测，返回 `worktree_unverified`。
- Hub 的删除 endpoint 以 `metadata.lifecycleState === 'archived'` 为服务端前置条件。

## 4. 拆解验证

每项均为可观察结果与检测方式，不以“已调用某函数”作为验收。
对应的 Cortex 执行 manifest 为 `.cortex/verify/archive-cleanup-worktree.manifest`；在实现开始前经人审冻结，完成前由 `cortex verify archive-cleanup-worktree` 生成 receipt。

| 可观察结果 | 检测 | 是否进 CI |
| --- | --- | --- |
| 干净、已合并且归属正确的 HAPI worktree session 归档成功；对话为 archived，`git worktree list` 不含该路径，`git show-ref` 不含该分支 | CLI/Hub 集成测试使用临时 Git repo；路由级测试断言响应与持久化状态 | 是；相关 Vitest 用例随 `bun run test` 执行 |
| 有 staged、unstaged 或 untracked 文件时，归档返回 `409 dirty_worktree`；session、目录、分支均未改变 | worktree helper 单测覆盖三类状态；Hub 路由测试 | 是 |
| 有已提交但未合并的分支提交时，归档返回 `409 unmerged_commits`；即使 `git status` 干净也不删除分支 | 临时 Git repo 集成测试，断言分支与 commit 仍存在 | 是 |
| 分支已合并到记录的基线时，允许清理；基线缺失、变为不可解析或无法证明合并时阻止 | Git helper 单测与临时 repo 集成测试 | 是 |
| runner 离线、RPC 未注册或 socket 断开时，归档返回 `409 machine_offline`，不写 archived | `RpcTargetMissingError` 路由/engine 测试 | 是 |
| metadata 路径、注册 worktree、当前分支三者不一致时，返回 `409 worktree_unverified`，不执行删除 Git 命令 | helper 单测；执行器 mock 断言无 remove/branch-delete 调用 | 是 |
| agent 在首次预检后产生修改时，最终复检阻止归档；目录与分支仍在，响应说明 agent 已停止 | runner/Hub 协调测试，以受控 fake Git 状态模拟两次检查不同 | 是 |
| `git worktree remove` 或分支删除失败时，Hub 不写 archived，错误可见且不使用 `--force` | 失败注入单测；命令参数断言 | 是 |
| 普通 session 归档不触发任何 worktree RPC，原有归档行为保持 | Hub 路由测试 | 是 |
| `DELETE /sessions/:id` 对 inactive 但未 archived 的 session 返回冲突；对成功 archived 的 session 才删除对话 | Hub 路由测试 | 是 |
| Web 对每个 blocker 显示可行动的错误文案，且失败后 session 仍在当前列表状态 | Web 组件/Hook 测试 | 是 |
| 无 blocker 时点击归档不显示确认弹窗并直接完成 | Web 组件/Hook 测试；浏览器成功场景 | 是 |
| blocker 时才显示继续归档弹窗；取消不变更状态，继续传递 force | Web 组件/Hook 测试；浏览器 dirty/未合并场景 | 是 |
| 强制归档 dirty/未合并 worktree 会明确接受丢弃成果并删除目录/分支；offline/unverified 强制归档保留目录 | Hub/CLI 测试；隔离 Git 人审 | 是 |
| 全仓类型、单测和 web build 不回归 | `bun typecheck`、`bun run test`、`bun run build:web` | 是，现有 `.github/workflows/test.yml` 已覆盖 |

实现完成后，除上述自动化证据外，进行一次隔离临时仓库的人审流程：分别制造干净已合并、dirty、untracked、未合并 commit、runner 离线五种状态；确认正常路径无弹窗，blocker 才弹窗，取消/继续结果以及 UI 与 Git 最终状态符合本表。该人审不操作现有项目 worktree，不进入生产环境。

## 5. 非目标

- 不清理本功能实施前已经遗留的 worktree 或分支。
- 普通归档不因归档自动 merge、rebase、commit、stash 或丢弃用户改动；只有用户明确选择强制归档时，才丢弃 dirty/未合并成果。
- 不通过分支名前缀、目录命名规则或当前默认分支推断可删除性。
- 不引入数据库 migration、后台 pending 队列或生产服务重启。
