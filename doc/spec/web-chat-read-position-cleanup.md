# Web Chat 阅读位置 — Router 接管与残留清理 Spec

> 项目：`veniai/hapi` fork
> 基线：`work/current`，commit `5ffc151`（revert）之后
> 关系：不取代 `web-chat-read-position-sync.md` 的产品契约（§1–§13 仍有效）；本 spec **重写其 §14 实现状态**、**降级其 §3.2.5 跨端语义**、**定义清理方案**。两者冲突时以本 spec 为准。
> 状态：**cleanup 已执行 + 部署 live**（阶段 0-5，commit `d3aabb3`→`55af75a`；migration v12→v13 于 2026-07-21 上 live，`user_version` 13，`attention_rev`/`handled_rev` 存活，公网 200，DB snapshot `~/.hapi/hapi.db.pre-v13-cleanup-1784597825058` 备用未用）。**§9 anchor 待批提案，未实施。**

---

## 1. 背景与根因（本次调查产出，必读）

`web-chat-read-position-sync.md` 那套重做的跨端阅读位置同步（hub locator + read-position reporter + chat-scroll-store + LWW entry target），在 commit `5ffc151` 被 revert（造成 live 卡顿）。revert **只砍消费侧、没清残留**，留下三套位置机制并存且互相矛盾，commit message / 原 spec §14 / 实际行为三方对不上。

两轮深查（含 node_modules 证据）坐实真相：

**单设备阅读位置恢复早就在工作，机制是 TanStack Router `@tanstack/router-core@1.171.6` 的 scrollRestoration——不是 spec 那套。** 关键机制（也是前两次判错的盲点）：

- `web/src/router.tsx:1402` `scrollRestoration: true` + `web/src/lib/scrollRestorationKey.ts` 按 `/sessions/{id}` `pathname` 分桶。
- **该版本 Router 不需要注册 scroll container**：在 `document` 上挂**捕获阶段** scroll 监听（`router-core/.../scroll-restoration.ts` 内 `addEventListener('scroll', onScroll, true)`），自动追踪**所有**滚动元素——包括 chat 那个内部 `<div className="app-scroll-y">`（不是 window/body）。
- 导航前 / pagehide 用 **CSS 选择器**（`localName:nth-child(N) > …`）当 key，把每个元素的 scrollTop 存进 `scrollRestorationCache[cacheKey]`（sessionStorage `tsr-scroll-restoration-v1_3`）。
- 路由渲染完成后 `onRendered` 订阅遍历缓存，对非 window 选择器直接 `element.scrollTop = scrollY` 恢复——**无需 `useElementScrollRestoration` / `data-scroll-restoration-id`**。
- Router 自己设了 `history.scrollRestoration = 'manual'`。
- **时序定胜负**：`OnRendered` 用 `useLayoutEffect` emit，React 提交顺序"子先父后" → **HappyThread 落底（`restoreInitialLatestPosition`）先跑 → Router 恢复后跑覆盖** → 最终 painted scrollTop = 上次离开时的值。
- 配合 `web/src/lib/message-window-store.ts`（模块级单例 Map + sessionStorage hydrate 强制 `hasLoadedLatest: true`）缓存旧消息窗口，使恢复的像素落在"上次那批消息"的同等高度，位置语义对得上。

**含义反转**：单设备恢复已免费可用，且恰好实现原 spec §3.2.4（同端精确恢复消息 + 偏移）。spec 那套重做的 read-position / locator / reporter / chat-scroll-store 是**重复造 Router 已有的轮子，还更重更卡**——这才是它被 revert 的真正原因。

**已知限制**：Router 是**像素**恢复，存在两个经调研确认的**真实缺陷**（见 §9，待决策修不修）——我先前"符合 §3.2.4 软要求、不视为硬 bug"的判断**错误**，调研显示两者都是高频可察觉问题：
1. 离开期间 session 来新消息时，`HappyThread` 挂载强制 `atBottom=true` → `fetchLatest` 整体替换窗口 → scrollTop 钉在旧像素 → 新消息在视口下方**无提示**（"以为 agent 没回复"）。高频。
2. Router 用 `nth-child` CSS 选择器当 cache key，HAPI 顶层 banner 栈（Offline/Reconnecting/Syncing）任意出现/消失即让选择器失效 → 恢复失效落底。中高频。

**教训**：前两次判定（"Router 对内部 div no-op"）基于错误假设"无 element 注册 = no-op"。任何 claim——别人的、agent 的、自己的——必须拿 codebase / node_modules 证据验证后再采信。

---

## 2. 决定

1. **现状**：TanStack Router scrollRestoration 是单设备阅读位置恢复的**现行**机制（实现原 spec §3.2.4）。**目标（§9 Step 2，若获批）**：durable-root anchor 接管为主、Router 像素法退 fallback——**前提是先解决 Router `onRendered` 覆盖 anchor 的时序**（§9.3 P0，待验证 Router opt-out / 延后机制）。
2. **跨端（原 spec §3.2.5，电脑读 / 手机续读）降级 deferred**——单设备满足主用例，重做跨端是上次翻车的路。
3. **彻底清理**重复 / 半残 / 死代码，含 DB migration 删 `last_read_message_id` / `last_read_at` 列。
4. **红点 G1**（`attentionRev` / `handledRev`）全程不动。

---

## 3. 清理后定位链（目标架构）

1. **durable-root anchor**（主，§9.3）— 切回定位到离开时第一可见 durable root message + offset。
2. **Router scrollRestoration**（像素 fallback）— anchor miss 且窗口未变更时。
3. **`restoreInitialLatestPosition`**（落底 last resort）— 首次 / 无缓存。
4. **`scrollToSentMessage`**（发送置顶）。
5. **`loadOlder` / 增量 append newer**（分页保滚动，复用 `LoadNewerIndicator`）。

删 `locator` / `saved`（spec 那套 pixel restore）/ `pickEntryTarget` / `useReadPositionReporter`（§3.2.5 重做轮子）。**保留 `chat-scroll-store`**（§9.3 anchor 依赖：write 活 + 接 read）。

---

## 4. 清理方案（5 阶段）

每阶段结束跑对应机械门。模式：删源码 → 同步删/精简其 `*.test.ts(x)` → 机械门。

### 阶段 0 — 迁移 `shouldMarkSessionEntry`（隔离红点的机械重构）

腾出 `read-position-target.ts` 整文件删；该函数是红点 G1 门控，先隔离。

- `web/src/lib/sessionAttention.ts`：新增 `shouldMarkSessionEntry`（从 `read-position-target.ts` 原样搬）。
- `web/src/router.tsx`：import 改 `from '@/lib/sessionAttention'`（调用点不动）。
- `read-position-target.test.ts` 的 `shouldMarkSessionEntry` 用例搬到 `sessionAttention.test.ts`。
- **门**：`cd web && bun typecheck && bun test`，特别验 `sessionAttention.test.ts` / `PendingInboxFab.test.tsx` / `SessionAttentionIndicator.test.tsx` 全绿。

### 阶段 1 — Web 死代码（不动 Session 类型）

- **整文件删**：`web/src/hooks/useReadPositionReporter.ts`、`web/src/lib/read-position-target.ts`(+test)。**`chat-scroll-store.ts` 不删**——留作 §9.1 的本机 messageId anchor 依赖（write 已活，§9.1 接 read）。
- **`web/src/components/AssistantChat/HappyThread.tsx`**：删 locator 整套（`locatorTargetMessageId` prop、`restoreLocatorTarget`、`locatorTarget*Ref`、`cancelLocatorRestore`、对应 useLayoutEffect）、删 saved pixel 死代码（`pendingSavedScrollRef`、`restoreSavedPosition`、`verifySavedRestore`、`cancelSavedVerification`、`resolveSavedScrollPosition`——皆因 `pendingSavedScrollRef` 永远 null 而死）、删 dead prop `hubLastReadAt`。**保留并待 §9.3 改造**：`captureScrollAnchor`/`restoreScrollAnchor`（§9.3 改抓 durable root；prepend 也复用）、**viewport persist write 端**（`persistViewportPosition`/`scheduleViewportPositionPersist`/`writeChatScrollPosition`，§9.3 接 read 的依赖）、`restoreInitialLatestPosition`、`scrollToSentMessage`、分页。`HappyThread.test.tsx` 同步删引用已删符号的用例，保留落底/发送/分页/anchor 用例。
- **`web/src/components/SessionChat.tsx`**：删 `locatorTargetMessageId` + `hubLastReadAt` 传递。
- **`web/src/hooks/queries/useMessages.ts`**：删 `loadInitial` + `clearChatScrollPosition` import + `fetchLocatedWindow` import/引用 + 返回字段 + 引用 `loadInitial` 的注释（77-79 行）；**保留 auto effect `fetchLatestMessages`**。
- **`web/src/lib/message-window-store.ts`**：删 `fetchLocatedWindow`（dead）+ 其 test 的 describe 块；**保留**缓存/hydrate（Router 恢复依赖）。
- **`web/src/hooks/useSSE.ts`**：删 `session-read-position` 事件分支（连带 lastRead 字段）；**不动**同文件 `session-updated` / `attention` 红点分支。
- **`web/src/router.tsx`**：删 `gcChatScrollPositions` import + 调用、删 `locatorTargetMessageId={null}`；**保留** `scrollRestoration: true` + `getScrollRestorationKey` + markSessionSeen。
- **不碰** `web/src/lib/scrollStorageGuard.ts`（保护 Router 自己的 sessionStorage）。
- **门**：`cd web && bun typecheck && bun test && bun run build:web`。

### 阶段 2 — Hub dormant 路由 & 方法（不动 DB 列 / 类型）

- **HTTP 路由**：`hub/src/web/routes/sessions.ts` 删 `POST/GET /sessions/:id/read-position`；`hub/src/web/routes/messages.ts` 删 `GET /sessions/:id/messages/locate`（+ test mock）。
- **syncEngine**：删 `getSessionReadPosition` / `updateSessionReadPosition` / `locateMessageWindow` / lastRead 给 reporter 的透传 + `syncEngine.ts:320` 的 `session-read-position` SSE 发射。
- **store**：`sessionStore.ts` 删 `setSessionReadPosition` 包装（**保留** `bumpAttentionRev` / `advanceHandledRev`）；`sessions.ts` 删 `setSessionReadPosition`；`messageStore.ts` 删 `locateMessageWindow` 包装；`messages.ts` 删 `locateMessageWindow` 函数（+ `messages.test.ts` 对应 describe 块）。
- **`sessionCache.ts` lastRead 透传留到阶段 3**（等类型字段删了再一起删，否则 typecheck 红）。**绝对不动** `getUnreadStartMessageId` / `bumpAttention` / `lastAttentionMessageId`（红点 G1）。
- **门**：`cd hub && bun typecheck && bun test`。

### 阶段 3 — DB migration v12→v13 + 跨 workspace 类型字段清理（人批 + DB 快照）

详见 §5。类型清理覆盖：hub `store/types.ts` + `store/sessions.ts`（row 类型 + SELECT mapping）、`sync/sessionCache.ts` 透传、**shared** `sessionSummary.ts` + `schemas.ts`（lastRead 字段 + `schemas.ts:440` 的 `session-read-position` 事件 literal）、**web** 7 个 fixture 删两行（仅字段行，不碰红点断言）。**门**：根 `bun typecheck && bun run test && bun run build:web`。

### 阶段 4 — e2e 清理

- **删** `web/e2e/chat-entry-position.live.spec.ts` 整文件（测的就是被删系统）。
- **改** `web/e2e/read-position-refresh.spec.ts`：删 `hapi.chat-scroll.v2.*` localStorage 探针（纯 console.log 诊断，core assertion `after.first === before.first` 不依赖它）；**保留** core assertion（reload 后首条可见消息一致）。对齐 §9.3 新 anchor schema 的探针重定向**挪入 Step 2 实施计划**（Step 2 未批准，不在本清理范围）。
- **不动** `red-dot-send-clears-both.spec.ts`。

### 阶段 5 — 更新原 spec + 文档（收尾）

- `doc/spec/web-chat-read-position-sync.md`：头部状态行改为指向本 spec 的指针（已做）；§14 开头加"现状见本 cleanup spec §1，§3.2.5 跨端降级 deferred"。G1–G5 正文留作历史记录（保留红点 G1 实现记录），不删。
- `AGENTS.md`：`store/` 标注 `better-sqlite3` → `bun:sqlite`。**已按 cortex 流程完成**（改 `.cortex/project.md` → `cortex init` 重新生成，不再直接改 AGENTS.md 生成产物）。

---

## 5. Migration（v12 → v13）

位置：`hub/src/store/index.ts`。

- `SCHEMA_VERSION` 12 → **13**。
- `createSchema()` 删 `last_read_message_id` / `last_read_at` 两列（fresh DB 直达 v13）。
- 新增 `migrateFromV12ToV13`（**idempotent**：`PRAGMA table_info` guard 后 `ALTER TABLE sessions DROP COLUMN …`）。
- `buildStepMigrations` 注册 `12: () => this.migrateFromV12ToV13()`。
- **不动历史 migration**（`migrateFromV10ToV11` ADD COLUMN 等保留，否则升级路径断）。
- 新增 `hub/src/store/migration-v13.test.ts`（仿 `migration-v12.test.ts`）：① fresh DB 无两列 + `user_version=13`；② V12→V13 drop 两列；③ idempotent；④ **`attention_rev` / `handled_rev` 存活**（保护红点）；⑤ 已有 session 行数据完整。

**模式选择**：引擎是 **`bun:sqlite`**（Bun 1.3.14 内置 SQLite **3.53.0**，已实跑 `select sqlite_version()` 验证；与 `AGENTS.md` 标注的 better-sqlite3 不符，以实际代码为准），原生支持 `DROP COLUMN`（≥3.35.0）。两列无索引 / 无 UNIQUE/PK/CHECK/FK / 非生成列，满足前置条件。直接 DROP COLUMN 比"重建表"安全（重建表须精确复刻全部保留列 + 索引，漏列静默丢数据）。**deploy 前在目标环境再跑一次 `select sqlite_version()` 确认 ≥3.35.0。**

---

## 6. 红点 G1 隔离边界（清理时绝对不碰）

**web**：`sessionAttention.ts`、`sessionLastSeen.ts`、`useSessionLastSeen.ts`、`SessionAttentionIndicator.tsx`、`PendingInboxFab.tsx`、`SessionList.tsx`、`session-summary-patch.ts`、`router.tsx` markSessionSeen、`useTabVisible.ts`、`read-position-target.ts` 的 `shouldMarkSessionEntry`（阶段 0 迁移）。
**hub**：`bumpAttentionRev` / `advanceHandledRev`、`attention_rev` / `handled_rev` 列（v12）、`sessionCache.bumpAttention` / `getUnreadStartMessageId` / `lastAttentionMessageId`。
**守护**：migration-v13.test 含 "attention/handled rev survive" 用例。

---

## 7. 验证与 Deploy

**机械门**（每阶段 + 全量）：`bun typecheck && bun run test && bun run build:web`（根目录全 workspace）。

**浏览器手验**（dev 起服务，避开 prod 3006/5173，用 alt port）：① 进看过 session → 滚中间 → 切走 → 切回 → 落回原位置（Router）；② 清 sessionStorage → 刷新 → 进 session → 落底（fallback）；③ 首次进新 session → 落底；④ 发消息 → 滚到刚发出（scrollToSentMessage）；⑤ 滚顶 loadOlder / 滚底 fetchNewer → 视口不跳；⑥ 红点 G1 回归（另一 tab attention 亮 → 发送灭）。

**migration test**：§5 五用例全绿。

**Deploy**（阶段 3 触发 migration 分支，按 `AGENTS.md` Cortex envelope）：
- 走 **Goal B migration 分支**：人显式 grant + DB 快照（SQLite backup API，WAL-safe，非 cp；`~/.hapi/hapi.db.pre-v13-<runid>`）+ `PRAGMA integrity_check` + 读 `user_version` 验证可恢复。
- deploy 前目标环境确认 `sqlite_version() ≥ 3.35.0`。
- web：`bun run build:web` → restart `hapi-web`（routine）。
- hub / shared / migration：restart `hapi-hub`（migration v12→v13 跑）。
- 验证：`user_version` 13 ✓ · `table_info(sessions)` 无 last_read 两列 ✓ · `attention_rev` / `handled_rev` 仍在 ✓ · `/health` + `hapi.zhetengde.xyz` 200 ✓ · 双端红点 + 长 session 进入/续读 smoke。
- 回滚：migration 失败 → DB restore（人批，丢快照后写入）+ 代码回 v12 last-good SHA。routine corrective 回滚（schema 未变场景）= reset 到 last-good SHA + restart，无 DB restore。

---

## 8. 决策记录

| 决定 | 原因 |
|---|---|
| Step 1 Router 主；Step 2 anchor 主（待 §9.3 P0 解决） | 现状 Router 免费给、本机、不卡顿；目标 anchor 更准但须先解 Router `onRendered` 覆盖 anchor 的时序 |
| 跨端 §3.2.5 降级 deferred | 单设备满足主用例；重做跨端是上次 35 commit 翻车的路 |
| 彻底清含 DB migration | 半残 write + dormant 路由 + 死列造成三方矛盾，留着=持续负债 |
| `DROP COLUMN` 直接删 | bun:sqlite 3.53.0 支持，两列无约束，比重建表安全 |
| 保留 `restoreInitialLatestPosition` 落底 | Router 缓存缺失（首次 / 清 sessionStorage）时的唯一 fallback |
| 不碰原 spec §1–§13 产品契约 | 产品需求未变，只是实现路径换为 Router |

---

## 9. 已知缺陷与修复方案（2026-07-20 调研 + codex 审查返工）

三个真实缺陷 + 用户锁定的产品意图。方案经 codex 批判性审查（session `019f7d7b-629c-7840-929b-76048a105bdb`，15 条 claim 逐条核实**全部成立**）返工：原"fetchNewer 取新消息 / overflow-anchor 免费解漂移 / user-turn anchor"三个支柱被证伪，改更小路径。

### 9.1 产品意图（已锁定，不再征询）

切回 session，**停在离开时看的那条消息**，期间新消息出现在**它下面**，顺着**往下接着读**。离开时在底部同样适用——**这是产品刻意覆盖 auto-follow**（现状 `atBottom` 时 SSE 直接 append + 跟底，`message-window-store.ts:1246`）；"切回"这一刻冻结 auto-follow、停旧位置，二者不矛盾。

### 9.2 三个缺陷（现状）

- **落顶**（间歇）：Router nth-child selector 失配 + fetchLatest 失败（catch 不 bump messagesVersion → 兜底不跑）→ scrollTop 卡 0。**注（codex）**：此为**已观察组合条件（hypothesis）**，非严格必要——其他 owner / 空窗 / 目标未 mount 也可能导致 0，需真浏览器 trace 最终确认。
- **错位**（高频）：HappyThread 强制 `atBottom=true` → fetchLatest 整体替换窗口 → scrollTop 钉旧像素 → 新消息在视口下方无提示。
- **selector 脆弱**（中高频）：nth-child 链被顶层 banner 栈打断 → Router 静默跳过 → 落底。

### 9.3 修复方案（返工版：durable-root anchor + 增量 newer，不留 locator）

**codex 证伪的旧支柱（已弃）**：
- ~~`fetchLatest→fetchNewer` 取离开期间新消息~~：`fetchNewerMessages` 双早返（`message-window-store.ts:1198-1199` 要求 `hasNewer`+cursor），latest/hydrate 窗口 `hasNewer=false` → **拿不到**。
- ~~CSS `overflow-anchor` 免费解漂移~~：`index.css:394` `.happy-thread-messages > * { overflow-anchor: none }` 显式关了——**factual 错**。若要用须显式改 CSS + 实测，列为实验项，**非支柱**。
- ~~`captureScrollAnchor` 只抓 user message（turn boundary）~~：现状抓任意带 id 子节点（`HappyThread.tsx:87`），UserMessage 无 dataset 区分（codex ★4）；且长 agent 回复时 user turn 在视口上方会 miss。改 durable-root（见下）。

**新方案**：
- **anchor = 第一可见 durable root message + offset**（非 user-only）。`captureScrollAnchor` 沿用"第一相交 + offset"，候选限定 durable root。
- **前置（必做）—— durable dataset**：root message 加正向 dataset。**durable 来自消息 metadata 的 persisted DB identity，不按组件类型一刀切**（codex P1）：
  - UserMessage / AssistantMessage 主消息：DB row UUID，durable。
  - SystemMessage **分类**（agent 验证 `reducerTimeline.ts`）：直接系统消息有 DB-row id（durable）；合成事件（title-changed / summary / task-notification）是 `${parentId}:${idx}` 派生 id——重载可定位但 **hub `/locate` 不识别**，**不算 durable anchor 候选**。
  - UserMessage 当前无 dataset（codex ★4），先补 `data-hapi-durable` + `data-hapi-role`。
  - selector 用 `[data-hapi-durable]` 正向选，**不靠 `agent-reasoning:`/`tool-group:` 黑名单**（黑名单对未来新复合类型脆弱）。
- **anchor restore 时机（P0-1，codex 复审）**：**不放 HappyThread `useLayoutEffect` 直接 set scrollTop**（会被 Router `onRendered` 覆盖，spec §1 已记录）。改用 **`router.subscribe('onRendered', () => restoreAnchor())`**——应用 handler 晚于 Router pixel-restore、同一同步批次、paint 前、零 flash（agent 验证 `router-core/router.ts:1251-1262` + `Match.tsx:236-249`）；或 **layout effect 内 `requestAnimationFrame(restoreAnchor)`**（同样零 flash、不耦合 router 内部）。两者都在 Router 像素恢复**之后**覆盖。不可行：让 Router 跳过 chat viewport（v1.171.6 无 per-element opt-out）。
- **切回定位优先级**：① anchor 命中（subscribe/rAF restore）→ ② **像素法（Router）兜底，仅窗口未变更前**（anchor miss 且窗口已变，像素值已错，跳过直接落底）→ ③ 落底。
- **新消息：先恢复旧 window，再增量 append newer**（不 fetchLatest 替换）。复用 `LoadNewerIndicator` / continue-reading。**append pinning（P0-2）**：`trimPreservingQueued('append')` 丢 oldest（`VISIBLE_WINDOW_SIZE=400` / `OLDER_LOAD_WINDOW_SIZE=800`），离开期间 newer 超 800 会逐出 anchor → entry append 阶段 **pin anchor 所在窗口**，或 newer 暂存 pending buffer 逐页合入（用户继续阅读时再 merge）。
- **forward cursor（P0-3，真要写的新逻辑）**：cursor 是 `(positionAt, seq)`（`message-window-store.ts:1204`），**仅 located-window 有**（fetchLatest 置 null，cold latest 无）。必须从 raw `DecryptedMessage` store 派生 `(positionAt, seq)` 并持久化，**不从 DOM id 反推**；定义被删 / 无 seq / synthetic 排除规则 + 服务器无更新 / 多页 / cursor 丢失行为。
- **多 fetchLatest 入口 owner race + invalidation（P0/P1）**：定义 `{sessionId, entryGeneration}` 所有权（entry effect / SSE reconnect / `messages-invalidated` 三入口）。**`messages-invalidated` 同步 `clearMessageWindow` + generation/epoch bump**（`App.tsx:258-267`）——late response 被挡但**救不回已清窗口**：entry transaction 期间 invalidation 必须**排队**或先 **snapshot/preserve** 当前窗口，不能只给 fetch 加 token。
- **restore 阶段**（codex：`messagesVersion` 不表示 DOM mount）：数据 ready → Router `onRendered`（或 rAF）查询目标 → **最多一次下一帧重试**。**不挂常驻 ResizeObserver**（永久存活、callback 每次 resize 跑一长串 = 卡顿源），不把"内容不再 reflow"当完成条件。后续 markdown/image/font reflow 的 offset 漂移列为**接受的 residual risk**（不再声称自动修正）。
- **存储（P1 定死）**：anchor 用 **`sessionStorage`**（隔离 tab；codex ★9：现 localStorage 多 tab 共享、最后写者覆盖）。迁移：现有 `hapi.chat-scroll.v2.*` localStorage key 写一次清理（或忽略旧 key）。
- **不留 hub locator**：window 丢失（配额/GC/private mode/`messages-invalidated` 清窗）直接降级 latest/bottom。`fetchLocatedWindow` / hub `/messages/locate` 删（§4 阶段 1/2）。

**第一步（独立、先做、止血）**：`HappyThread.tsx:1149` `.app-scroll-y` 加 `data-scroll-restoration-id={`chat-${sessionId}`}` → Router 像素法 fallback 稳，解 selector 脆弱。**收回"零风险"措辞**（codex：同 document 唯一性——两 thread 并存——是 hypothesis，需验）。此步独立发 + 量化剩余两缺陷发生率，再决定上不上 anchor 状态机。

**卡顿红线（可验证，非口号）**：
- 定义单一 `entryRestoreState`（列 terminal states）；send / prepend / entry 三种滚动事务显式优先级。
- entry restore **不挂常驻 RO**，一次 layout effect + 有界 RAF；常驻 RO 只做 O(1) bottom-state，加 callback 次数/耗时指标。
- 不串行 load-until-found、不调 hub。
- **不重造 prepend 双轨**（现有 `loadOlderPreservingScroll` 的 anchor/delta，`HappyThread.tsx:866/1085-1094`，保留），只换 anchor selector 为 durable-root。

### 9.4 实施坑清单（codex 返工：修 grounding + 措辞）

| 坑 | 来源 | 状态 | 应对 |
|---|---|---|---|
| optimistic 临时 id 断链 | `ddf2da0` | **部分**（write 端 :99 仅前缀过滤；optimistic→confirmed ID 替换期竞态未处理） | anchor write 只接受消息模型标记 persisted/confirmed 的 ID，不靠命名约定 |
| 复合 id（`agent-reasoning:`/`tool-group:`） | `0335313` | **还在**（selector 选所有 `[id]`） | **正向 durable dataset**（§9.3 前置），不黑名单 |
| 锚点元素不在 DOM（折叠/过滤/trim） | 现码 `HappyThread:812`（target miss 重试 20 次取首元素） | **还在** | miss 时按同窗 durable seq 的 predecessor 定位；无序元数据则像素/落底。**原 spec 把 `bc4dbf3` 当此坑证据是 grounding 错**（该 commit 是 saved 像素策略、无 NB-3），已撤 |
| 抓哪条当锚点 | `ac53562`（agent reporter，**非 user**） | **部分**（仅证 partially-visible 优于 fully-visible；user/root anchor 选择未解） | durable-root 第一相交 + offset；`ac53562` 不作"已解"依据，已撤 |
| 还原时机 | 落顶调研 | **还在** | §9.3 restore 阶段（数据 ready → useLayoutEffect → 一次 RAF），不依赖 fetchLatest bump |
| jsdom 测不到 | 项目已知 | **还在** | 必须 Playwright |

### 9.5 单设备躲掉的

- **跨端 reporter**（`0335313` reporter CAS）→ 不做跨端就没。
- **locator 串行链** → window 丢失降级 latest/bottom，**不留 hub locate**（与 §9.3 一致）。

### 9.6 工作量评估（codex 返工：去过度乐观）

- **收回**先前"设计层确定=是 / battle-tested / 一行零风险 / fallback 不比现状差"等措辞——均被 codex 证伪或标 hypothesis。
- **核心仍不难**（getElementById + offset），但 **write 端非白捡**：durable dataset 要先补、optimistic 要状态标记、`captureScrollAnchor` 要改造。
- **真要写的新逻辑**：Router `subscribe('onRendered')`/rAF restore（P0-1）+ append pinning（P0-2）+ forward cursor 从 raw store 派生（P0-3）+ `entryGeneration` + invalidation 排队/snapshot（P1）+ durable dataset（含 SystemMessage 分类）+ optimistic persisted 标记。
- **躲掉的**：跨端 reporter、locator 串行链。
- **判定**：方向对（codex 认可 anchor 方向），但比先前评估重——durable dataset 前置 + forward cursor + owner race 是真实工作量。**第一步（`data-scroll-restoration-id`）独立做、量化后再决定 anchor 状态机要不要上**。

### 9.7 验证方式（codex 返工：改判据 + 补协议 + race）

**铁律**：真浏览器（Playwright），jsdom 不算数。

| 风险点 | 验证 | 完成判据 |
|---|---|---|
| 第一步 selector | Playwright：OfflineBanner + 切走切回 | 落离开位置；`querySelector('[data-scroll-restoration-id]')` 命中 chat viewport；**ID 同 document 唯一性**（两 thread 并存）验证 |
| 落顶 | Playwright：mock fetchLatest 500 + 切走切回 | **记录离开 anchor ID+offset，回来断言同 ID、offset 误差 <阈值**（非 `scrollTop≠0`，后者 false pos） |
| 错位（续读） | Playwright：滚中间 → mock SSE 新消息 → 切走切回 | anchor rect offset 不变 + 注入消息 ID 顺序在其下 + live edge 未入视口；覆盖 ≤1 页和 >`PAGE_SIZE` 两类 |
| durable anchor | 单测+DOM：`captureScrollAnchor` 候选仅 `[data-hapi-durable]` root | anchor 无复合 id 前缀 |
| 元素不在 DOM | Playwright：anchor 那条被 trim/折叠 → 切回 | 同窗 predecessor 定位或像素/落底，不报错 |
| owner race | Playwright：快速 A→B→A、A fetch 未完进 B、SSE+navigation 同帧、reconnect late、optimistic→confirmed 期切回、StrictMode 双 effect | 旧请求/generation 不覆盖当前；anchor 不被 late replacement 冲掉 |
| 两 tab 同 session | Playwright 两 context：同 session 反向位置 | sessionStorage/tab-key 不互相覆盖 |
| **性能** | Playwright trace：固定 Chromium/viewport/长会话 fixture/CPU throttle；baseline vs after 各 **≥10 次**，比 median/p95 scripting、layout count、RO callback count；排除启动/network | **long task >50ms = 绝对红线**（必过）；p95 scripting/layout **作调查信号、非零容差 gate**（噪声敏感，小幅差异不判回归，需明显恶化 + 可复现才算） |

**性能基线**：实施前录 baseline，实施后对比，**回归 = 未完成**（§7 性能与正确性同级）。entry restore 不挂常驻 RO（§9.3）。
