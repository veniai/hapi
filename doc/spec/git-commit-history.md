# 会话 Git 提交历史（只读）— 规格

> fork: `veniai/hapi` · 工作目录 `/home/claw/projects/hapi` · 基线 `work/current`（2026-07）
> 状态：**计划已定，代码尚未改动**。本文件仅描述方案，未实现。
> 范围拍板：**只读、只看当前分支、不发起新提交 / stage / push / discard**。

---

## 背景 / 要解决的问题

点会话头部的「文件图标」→ `/sessions/$sessionId/files`，目前 Git 视图只有：
- 顶部分支名 + 两个扁平列表（已暂存 / 未暂存变更，每行状态字母 + 行数）；
- 单文件点开看 unified diff（纯文本一栏）。

**看不到提交历史**（commit log）：过去提交过哪些、每次改了啥。本 spec 补这一块。

现状（核查）：CLI git handler（`cli/src/modules/common/handlers/git.ts`）只有 `GitStatus` / `GitDiffNumstat` / `GitDiffFile`，**完全没有 `git log` 能力**。故需 CLI → shared → hub → web 全链路加一条「提交历史」，照现有 git 功能的 4 层模式照抄。

---

## 贯穿原则

- **只读**：纯查看，不 stage / commit / push / discard，不动用户仓库（与「能操作」那档严格区分）。
- **只看当前分支**：`git log` 跑在该会话工作目录（`session.metadata.path`）的**当前分支**上；在该目录切分支，历史跟着变（会话只记目录、不记分支——见下方「会话 cwd 模型」）。不看其它分支、不做分支连线图（Git Graph 那种）。
- **复用现有 git RPC 模式**：每个新能力 = CLI handler + `RPC_METHODS` 枚举 + hub 透传 + REST 路由 + web client/parser/hook，照抄 `GitStatus` 那套。
- **行号漂移**：实现前对引用行号重新走查。

---

## 会话 cwd 模型（决定了历史看的是哪个分支）

- 会话的「位置」= 一个**工作目录**（`session.metadata.path`），**不是分支**。分支每次实时读（git 命令当场跑在该目录）。
- 本地起的会话：cwd = 启动时终端所在目录；远程起（web/手机「新建」选文件夹）：cwd = 选的目录。
- 故「提交历史」= 该目录当前分支的 log。worktree 类型会话（新建表单 `sessionType: 'worktree'`）的 cwd 是隔离的 `hapi-xxxx` 分支目录 → 历史看那条分支。
- 推论：同一目录的多个 simple 会话共享同一分支历史；切分支后全部跟着变。

---

## 实现路线图

```
[CLI]  GitLog + GitCommitFiles + 扩展 GitDiffFile(commit)
   → [shared] RPC_METHODS 加两项
   → [hub]  rpcGateway + syncEngine 透传 + REST 路由（/git-log、/git-commit-files、扩展 /git-diff-file）
   → [web 数据层] types + gitParsers + client + query-keys + hooks
   → [web 界面] GitStatusBadge + CommitHistory + files.tsx 第三 tab + file.tsx/router 透传 commit
```

无跨项前置——一条链路自底向上，可一次性贯通。

---

# L1 · 后端（CLI + shared + hub）

## L1.1 · CLI git handler

**文件范围**：`cli/src/modules/common/handlers/git.ts`（唯一后端实现点）。

**方案**（复用现有 `resolveCwd` / `runGitCommand` / `validateFilePath`）：

1. **`GitLog`**：`git log -n 100 --format=%H%x1f%h%x1f%s%x1f%an%x1f%aI`
   - 字段：全 hash / 短 hash / 主题 / 作者 / ISO 时间，用 `\x1f`（unit separator）隔字段，每提交一行（`%s` 单行）。
   - 空仓库 / 无提交 → 空输出 → 空列表（handler 正常返回 success + 空 stdout）。
2. **`GitCommitFiles`**（入参 `hash`）：`git diff-tree --no-commit-id --name-status -r --root <hash>`
   - 返回该提交改了哪些文件 + 状态字母（M/A/D/T/U）。
   - `--root` 兼容首次提交（否则首提交无父、输出空）。
   - **状态字母够用，不取行数**（见「明确不做」）。
3. **扩展 `GitDiffFile`**：`GitDiffFileRequest` 加可选 `commit?: string`；有则跑 `git show <commit> --no-ext-diff --format= -- <filePath>`，否则维持现状（工作树 `git diff`）。
4. **`validateGitHash`**（新 helper）：`/^[0-9a-fA-F]{4,64}$/`——hash 来自 web（用户点开的提交），argv 传参本就不含 shell 注入，但仍校验成合法 hash（git 缩写 ≥4 位、SHA-1=40、SHA-256=64）。非法 → `rpcError`。

**硬约束 / 陷阱**：
- **`git show` 必须带 `--format=`**（已实测）：默认 `git show <commit> -- <path>` 在 diff 前先吐 `commit`/`Author`/`Date`/提交消息行，会污染 diff 视图（`DiffDisplay` 逐行渲染，这些行会变成顶部一堆无色杂行）。加 `--format=` 压成纯 diff。**勿漏**。
- **`diff-tree` 默认不检测重命名**（无 `-M`）：重命名在历史提交里显示为 D（旧）+ A（新）两条。可接受（v1）。
- **merge 提交**：`git diff-tree <merge>` 默认**无输出**（除非 `-m`/`-c`/`--cc`）→ 点开 merge 提交文件列表为空。可接受（多数提交非 merge）。
- `%x1f` 是 git 的 format 转义（字面文本 `%x1f` 传给 git，由 git 产出 0x1F 字节）——CLI 源码里就是字面 `%x1f` 字符串，无 JS 转义问题。

**Done 条件**：
- `GitLog` handler：正常仓库 → success + log stdout；空仓库 → success + 空 stdout。
- `GitCommitFiles`：合法 hash → name-status stdout；非法 hash → rpcError；首提交（`--root`）非空。
- `GitDiffFile`：带 commit → `git show` 路径；不带 → 原行为不变。
- （handler 是机械 shell-out，不另写测试，遵从「必要测试 ONLY」；逻辑测试落在 web parser 侧。）

**验证命令**：`bun run typecheck:cli`。

---

## L1.2 · shared + hub 透传 + REST 路由

**文件范围**：`shared/src/rpcMethods.ts`、`hub/src/sync/rpcGateway.ts`、`hub/src/sync/syncEngine.ts`、`hub/src/web/routes/git.ts`。

**方案**（照抄现有 `GitStatus` / `GitDiffNumstat` / `GitDiffFile`）：
- `shared/src/rpcMethods.ts`：加 `GitLog: 'git-log'`、`GitCommitFiles: 'git-commit-files'`。
- `rpcGateway.ts` + `syncEngine.ts`：加 `getGitLog(sessionId, cwd?)`、`getGitCommitFiles(sessionId, { cwd, hash })`；扩展 `getGitDiffFile` options 加 `commit?: string`。
- `hub/src/web/routes/git.ts`：
  - `GET /sessions/:id/git-log`（沿用 engine/session/sessionPath 守卫 + `runRpc`）。
  - `GET /sessions/:id/git-commit-files?hash=`，`commitHashSchema = z.string().regex(/^[0-9a-fA-F]{4,64}$/)` 校验。
  - 扩展 `/sessions/:id/git-diff-file`：加 `?commit=` query；**`commit` 非空时用 `commitHashSchema` 校验**（与 `/git-commit-files` 一致），透传。

**硬约束 / 陷阱**：
- 路由侧 `commitHashSchema` 与 CLI `validateGitHash` 双重校验（web→hub→cli，`/git-commit-files` 与 `/git-diff-file` 的 `commit` 都校验），纵深防御。
- 无 zod schema 校验 git 文本载荷（沿用现状——porcelain/numstat/log 文本都在 web 侧 client-parse）。

**Done 条件**：`bun run typecheck`（shared + hub 消费者覆盖）通过。

**验证命令**：`bun run typecheck`（全）+ `bun run test:hub`。

---

# L2 · web 数据层

**文件范围**：`web/src/types/api.ts`、`web/src/lib/gitParsers.ts`、`web/src/api/client.ts`、`web/src/lib/query-keys.ts`、`web/src/hooks/queries/useGitLog.ts`（新）、`web/src/hooks/queries/useGitCommitFiles.ts`（新）。

**方案**：
- `types/api.ts`：
  ```ts
  GitCommit { hash, shortHash, subject, author, authorDate }
  GitCommitFile { fileName, filePath, fullPath, status: GitFileStatus['status'] }
  ```
- `gitParsers.ts`：
  - `parseGitLog(stdout)`：按行 split，每行按 `String.fromCharCode(0x1f)` split 成 5 字段。
  - `parseGitCommitFiles(stdout)`：按行 split，每行按 `\t` split → `[statusLetter, path]`，首字母映射状态（复用 `GitFileStatus['status']` 联合）。
- `api/client.ts`：`getGitLog(sessionId)`、`getGitCommitFiles(sessionId, hash)`；`getGitDiffFile(sessionId, path, staged?, commit?)`。
- `query-keys.ts`：`gitLog(sessionId)`、`gitCommitFiles(sessionId, hash)`；扩展 `gitFileDiff(sessionId, path, staged?, commit?)`（commit 进 key，区分工作树 diff vs 提交 diff 缓存）。
- hooks（照抄 `useGitStatusFiles` 结构）：`useGitLog(api, sessionId)`、`useGitCommitFiles(api, sessionId, hash)`（后者 `enabled: !!hash`，展开时懒加载、TanStack Query 自动缓存）。

**硬约束 / 陷阱**：
- **0x1F 分隔符的实现陷阱**：parser 里 split 必须用 `String.fromCharCode(0x1f)`，**不可**在源码里写字面 `\x1f` 转义——编辑器/工具链易把 `\x1f` 当控制字符吞成空串（曾踩过：`line.split('')` 误判）。用 `fromCharCode` 一劳永逸。
- `parseGitCommitFiles` 不解析行数（name-status 无 numstat）。
- 相对时间在组件侧算（见 L3），不进 parser。

**Done 条件**：
- `gitParsers.test.ts`：`parseGitLog`（正常多提交 / 跳过空行与残行 / 空输出）；`parseGitCommitFiles`（M/A/D + 根文件 `filePath=''` / 空输出）。
- `bun run typecheck:web && bun run test:web` 通过。

**验证命令**：`bun run typecheck:web && bun run test:web`。

---

# L3 · web 界面

**文件范围**：`web/src/components/SessionFiles/GitStatusBadge.tsx`（新）、`web/src/components/SessionFiles/CommitHistory.tsx`（新）、`web/src/routes/sessions/files.tsx`、`web/src/routes/sessions/file.tsx`、`web/src/router.tsx`、`web/src/lib/locales/{en,zh-CN}.ts`。

**方案**：
1. **`GitStatusBadge`**（新共享组件，提交历史的依赖）：`status → {label,color}`（沿用现有 `--app-git-*-color` CSS 变量），带 `size?: 'sm'|'md'`。仅提交历史用（不扩散到 changes/directories——那是另一档显示增强，不在本 spec）。
2. **`CommitHistory`**（新组件）：
   - `useGitLog` 拉提交列表；每行 = 短 hash + 主题 + 作者 + 相对时间（`formatRelativeTime`：m/h/d，>7 天转 `MMM D`，组件内用 `Date`，浏览器侧可用）。
   - 点一行展开 → `useGitCommitFiles(hash)` 懒加载该提交改的文件（FileIcon + 文件名 + `GitStatusBadge size="sm"`）。
   - 点文件 → 调 `onOpenFile(fullPath, undefined, commit.hash)` 进 diff 视图（带 commit）。
3. **`files.tsx`**：
   - tab 由 2 个变 3 个（`变更 | 目录 | 提交记录`），`grid-cols-2` → `grid-cols-3`；`'history'` 进 tab 类型与 `initialTab` / `handleTabChange`。
   - 内容区加 `activeTab === 'history'` 分支渲染 `<CommitHistory>`。
   - 分支头在 `changes` 与 `history` 两 tab 都显示（标明在看哪个分支的历史）；「N staged / N unstaged」小字仅 `changes` 显示（history 下无意义）。分支名复用 `useGitStatusFiles` 的 `gitStatus.branch`——**接受**随之而来的整次 status 拉取（与 changes tab 共享缓存；为「只取分支名」单开 RPC 属过度设计，不做）。
   - `handleRefresh` 在 `history` tab 失效 `gitLog` query（而非 `refetchGit`）；**不**失效已展开的 `gitCommitFiles`——历史提交的文件列表不可变，本就无需刷新。
   - `handleOpenFile(path, staged?, commit?)`：history 下携带 `commit`、`tab:'history'` 进 /file。`tab:'history'` 仅作来源标记（与 directories 流程的 `tab:'directories'` 对齐）；**返回键是否落回 history tab 靠 URL 历史**（回到 `/files?tab=history`，files 路由据 `tab` 设 `initialTab`）——见「待实测项」。
4. **`file.tsx` + `router.tsx`**：`/sessions/$sessionId/file` 路由 search 加 `commit?: string`（router `SessionFileSearch` 类型 + `validateSearch` 解析；`sessionFilesRoute` 的 `tab` 联合加 `'history'`）。`file.tsx` 读 `search.commit`，传给 `queryKeys.gitFileDiff` 与 `api.getGitDiffFile`，复用现有 `DiffDisplay` 渲染 `git show` 的 unified diff。
5. **i18n**（en + zh）：新增 `files.tab.history`、`files.history.empty.none`（无提交）、`files.history.empty.commit`（该提交无改动文件）；`loading.git` **复用既有 key**（changes tab 已有，非新建）。

**硬约束 / 陷阱**：
- `GitStatusBadge` 仅本特性用；勿顺手改 changes/directories 的 badge（那是独立显示增强档）。
- `handleOpenFile` 的 `fileSearch` 对象类型要含 `commit?`（router 已扩 schema，否则类型不匹配）。
- `file.tsx` 的 `displayMode` 逻辑：提交 diff 有内容（仅展开 diff-tree 报告为改动的文件才会被点开）→ 正常走 diff；空 diff 会回落到 file 模式（不会发生）。
- `queryKeys.gitFileDiff` 必须把 `commit` 纳入 key，否则同一文件「工作树 diff」与「提交 diff」缓存串。

**Done 条件**：
- 手动：开有提交历史的会话 → 文件图标 →「提交记录」tab → 列表显示；点一条展开看改了哪些文件；点文件看该提交 diff；切分支刷新后历史跟着变。
- `bun run typecheck:web` 通过。

**验证命令**：`bun run typecheck:web && bun run test:web`。

**人工步骤**：dev（web :5173 代理 hub :3006）验证列表 / 展开 / 点文件 diff / 切分支变化；worktree 会话验证看的是 `hapi-xxxx` 分支历史。

---

# 明确不做（本轮，附理由）

1. **提交文件的行数（+N/-N）**：方案只取 name-status（状态字母），不取 numstat。理由：贴合「先不搞那么复杂」，name-status 单命令够用。要补：handler 加一次 `git diff-tree --numstat`，parser 合并，行加 `LineChanges`。
2. **其它分支的历史 / 分支连线图**：只看当前分支。理由：用户拍板「先就只看当前分支」。Git Graph 那种连线图是独立大件。
3. **stage / commit / push / discard 等写操作**：纯只读。理由：用户选只读档；写操作会动用户仓库（远程控制下是信任边界），是独立全栈任务。
4. **merge 提交的文件列表**：`diff-tree` 默认对 merge 无输出 → 显示空。理由：多数提交非 merge；要支持需 `-m`/`--cc`，解析变复杂。
5. **重命名检测**：无 `-M`，重命名显示为 D+A；`GitCommitFile` 故不带 `oldPath`。理由：v1 简化；要检测加 `-M` 并解析 `R100\told\tnew`，届时再加回 `oldPath` 字段。

---

# 待实测项

- **merge 提交空列表的体感**：实际仓库里 merge 提交占比 + 空列表是否困扰（决定要不要补 `--cc`）。
- **>100 条提交**：`-n 100` 封顶；超长历史仓库是否需要分页（v1 不做，先 100 条）。
- **从 commit 文件 diff 按返回**：是否落回「提交记录」tab（靠 URL 历史；若不落回，需修 `useAppGoBack` 或确认 `tab:'history'` 传递）。

---

# 验证 & 工作流（实现阶段通用）

- **自动化**：`bun run typecheck`（全 cli+web+hub；shared 随消费者覆盖）+ `bun run test`（重点 web parser 新用例）。
- **手动**（dev）：见 L3 人工步骤。
- **部署**（本 fork）：本次动 **shared + hub + cli + web 四层**——移到 deploy worktree（`cd /home/claw/deploy/hapi && git merge work/current`）后：web `bun run build:web` + 重启 `hapi-web`；hub 重启 `hapi-hub`；cli 重启 `hapi-runner`（shared 改了故三者都重启，会中断进行中的 agent 会话，挑时间）。
- **上游同步**：`git fetch upstream` → main 合 upstream/main；冲突可能落在 `git.ts` / `files.tsx` / `router.tsx`。
