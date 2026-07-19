# Web 双端红点与阅读位置 — spec (Go-ready v2)

> fork: `veniai/hapi` · 工作目录 `/home/claw/projects/hapi` · 基线 `work/current`（2026-07）
> 状态：**方案 + 契约定稿（Go-ready v2），代码尚未改动**。Codex 审 14 条契约补全（2026-07-18）。
> 触发场景：手机+电脑同时开 HAPI，两端交替操作（电脑看、手机语音输入），靠红点逐个处理 session，期望两端位置对齐、不插队、不跑顶。

> **实现状态（2026-07-19，commit 1c93dcb）— 与 spec v2 的偏离（实测为准）**
>
> §4.3 的 locator（`fetchLocatedWindow` 按 messageId 加载窗口）+ §4.3 `fetchNewerMessages` 的 **web 前端** 在浏览器 reload 下实测不稳：reporter 的 keepalive POST（pagehide 上报 hub lastRead）与 reload 的 GET-session 有 race，加上 content（markdown/code/font）reflow 的 layout 时序，使每次 reload 落点偏 1 条 message（e2e 反复复现）。hub 侧 locator/getMessagesAfterPage 代码保留（未删），仅 web 前端砍。
>
> 实际落地的 §4.3"看过的 session 切回不跑顶"机制：**hydrate（sessionStorage messages）+ saved restore（chat-scroll-store localStorage）+ 有界校验**（`HappyThread.verifySavedRestore`：restore 命中后，后续 ResizeObserver tick 比对 anchor 实际 offset vs saved topOffset，drift 则重 scroll，直到 2 stable tick / 6 tick / 1.5s；用户 scroll 取消）。Playwright e2e（真浏览器）验 reload 落回精确位置通过。Codex 诊断 + 方案。
>
> §4.5 跨端同步（hub lastRead 共享 + reporter 上报）：reporter 上报（§4.5(f)）仍按 spec（fully-visible agent，`captureReadPositionAnchor`），hub 存（migration 11 + LWW CAS + SSE `session-read-position`）保留；但 **web 前端 reload 不再消费 hub lastRead 作 locator target**（砍），跨端"手机落电脑水位"未实现。单设备场景（spec 触发场景的双端）目前不满足。
>
> §4.1 红点 / §4.2 排序按 spec 实现未变。
>
> 跨端同步后续若要恢复，需先解：(1) reporter POST / reload GET race（让 hub lastRead 在 reload 时可信，或 saved 优先不依赖 hub）；(2) locator target scroll 的 reload layout 时序（有界校验延伸到 locator target，或 locator 落 topOffset=0 + 校验）。

---

## Goal Contract（Go-ready；拆 Goal A / Goal B）

### Goal A — 代码 + ready-for-approval（本地 `work/current`）

**Outcome**：四块全部实现 + 单测 + `bun typecheck && bun run test && bun run build:web` 通过：
1. 红点不分叉（去 `selected` 排除；点击单端消保留）
2. 排序不插队（新完成 session 追加末尾）
3. 看过的 session 切回不跑顶（按 messageId 加载窗口）
4. 跨端阅读位置同步（任一端打开回到"最后阅读的那条消息"）

**Boundaries**：
- 改 web（`sessionAttention` / `SessionList` / `PendingInboxFab` / 新 `pending-since-store` / `chat-scroll-store` / `message-window-store` / `HappyThread` / `useSSE` / 新 `useReadPositionReporter`）+ hub（store migration 10→11 / sessions read-position route / messages locator API / syncEngine updater+getter / sse 经 eventPublisher）+ shared（schemas: SessionSchema + SyncEventSchema 加分支 / apiTypes）。
- **不碰**：红点 `lastSeenAt` per-device（不搬 hub）；不做发送跨端消红点；不加标记已处理；不同步像素/不逐 scroll 上报/不实时拽；不动 Telegram memory / 不改 SessionList 整体顺序 / **不动 sseManager**（SSE 经 SyncEngine eventPublisher）/ 不碰 CLI thinking（**thinking-mask 已上线**）。
- **§5 协调**：thinking-mask **已上线**（commit `e4582c5`，`sessionAttention.ts:14` 当前 `selected||archived` 短路 + permission/input 在 thinking 上）→ 只删 `selected` 短路 + SessionList suppress + permission/input 优先 spinner。

**Observable completion**（机械，§7.1）：见 §7.1 全清单（sessionAttention / pending-since-store / SessionList / migration-v11 / saved 恢复 / locator 三层测 / 跑顶回归）+ `bun typecheck && bun run test && bun run build:web` 通过。

**Permission envelope**：本地改 `work/current` + typecheck/test/build（**无 approval**）。产出 `ready-for-approval` branch（含 migration 代码 `migrateFromV10ToV11` + `migration-v11.test.ts`，但**不执行** live DB）。

### Goal B — 部署（migration 人批后）

**Outcome**：live hub 应用 V10→V11 migration + web dist 上线 + live probe 通过。

**Permission envelope**：走 `hapi-deploy`；**migration 人批**（standing auth 不预授权 migration）。

**Observable completion**（机械，§7.3）：
1. **immutable target SHA**：deploy == Goal A 合入 SHA（`--ff-only` 强制）。
2. **backup + integrity + user_version**：deploy 前 `user_version=10` + `integrity_check=ok`；deploy 后 `user_version=11`。
3. **授权状态**：deploy log 含 approved。
4. **三层 live probe**：`GET /health` 200；`GET /api/sessions` 含 `lastReadMessageId`/`lastReadAt`；`GET /sessions/:id/messages/locate?messageId=X` 200。
- **回滚**：integrity fail / user_version 不变 / probe ②③ 非 200 → 回滚 DB 快照（`rollback-ready-for-approval` 人批 DB restore）+ 旧版。

---

## 0. TL;DR

四块（只修真痛点；红点 `lastSeenAt` **不搬 hub**）：
1. **红点分叉** → 去 `selected` 排除（逻辑队列含当前；UI 跳过 selected）。点击单端消保留。
2. **排序插队** → 前端 `pendingSince`，新完成追加末尾（首帧原子 reconcile）。
3. **看过的 session 跑顶** → saved 按 messageId 加载窗口（新 messages locator API），根治脆弱的 loadOlder+ResizeObserver 循环。
4. **跨端位置不同步** → 阅读位置搬 hub 共享（sessions 加两列 + LWW CAS + SSE）。

---

## 1. 背景 / 根因（要点；详见 git history）

- **红点分叉**：`sessionAttention.ts:13` `selected` 短路 + `PendingInboxFab` 排除 selected → 两端 selected 不同 → 队列不同。点击单端消（`router.tsx:234` markSessionSeen）保留（窄边界，大部分不影响）。
- **排序插队**：`sessions.ts:71` createdAt 排序，新完成 session 创建晚排前 → 插队。
- **跑顶**：saved anchor 靠 loadOlder+ResizeObserver 脆弱循环找回，遇空批/高度不变即断 → 停顶部。
- **跨端位置**：`chat-scroll-store.ts` per-device localStorage，两端互不知。

---

## 3. 贯穿原则

1. 红点 per-device + 点击单端消。2. 只阅读位置碰 hub；红点不碰 hub。3. saved 根治不靠 fallback（按 messageId 加载窗口）。4. 同步锚点不像素（messageId）。5. 不实时拽（SSE 只更 cache）。6. hub dumb（只记账+广播）。

---

## 4. 方案

### 4.1 红点（去 selected 排除）

- `sessionAttention.ts:14`：删 `options.selected` 短路（保留 archived）。permission/input 仍在 thinking 之上（thinking-mask 已上线，不动顺序）。
- **逻辑队列 vs actionable 队列**（M7）：
  - **逻辑队列**（`classifySessionAttention` 返非 null）：**含 selected**（两端红点目标一致）。
  - **actionable**（`PendingInboxFab` count + 跳转）：**filter `session.id !== selectedSessionId`**。仅 selected pending → FAB 不显示（count=0）。
- **SessionList**：`classifySessionAttention(s, {selected:false})` + 渲染层 suppress（`selected ? null : rawAttention`）；permission/input **优先** thinking spinner。
- 点击单端消保留；lastSeenAt per-device；不加标记已处理。

### 4.2 排序不插队（pendingSince + 首帧原子）

- 新 `pending-since-store.ts`：localStorage `hapi.pendingSince.v1` = `Record<sessionId, number>`。导出 `getPendingSinceStore()` + `reconcilePendingSessions(pending, now=Date.now())`（M8：纯函数同步——pending 每个：无记录写 now、有不动；store 有但 pending 不含的删）。
- `PendingInboxFab` useMemo：**同帧**先 `reconcilePendingSince(logical, now)` 再读 store 排序（pendingSince 升序，无记录 createdAt 兜底）→ 首屏 pending 立即有 pendingSince（不靠 effect 后移，不闪）。

### 4.3 saved 根治（按 messageId 加载窗口）— locator 契约

- `chat-scroll-store` 存 **raw messageId**（现 anchor.id 是 DOM id `hapi-message-${id}`；改存 raw）。
- **hub store** 新 `locateMessageWindow(db, sessionId, targetMessageId, {beforeLimit, afterLimit})`：返回 `{messages(升序含 target), target:{at,seq}|null, olderCursor, hasOlder, newerCursor, hasNewer}`；target 不存在/不属于 session → null。SQL：旧方向 `position_at < target` DESC LIMIT beforeLimit+1（多1判 hasOlder）；新方向 `> target` ASC LIMIT afterLimit+1（多1判 hasNewer）；复用 `idx_messages_session_position`。
- **hub route** `GET /sessions/:id/messages/locate?messageId=&beforeLimit=&afterLimit=`：query Zod（messageId uuid, before/afterLimit 1-200 default 50）；响应 schema（messages+target+cursors+hasOlder/hasNewer）；session 不存在→404；messageId 不属 session→**404**（不是 200+null）；格式错→400。
- **SyncEngine** 新 `locateMessageWindow(sessionId, ns, targetId, opts)`：resolveSessionAccess → store.locateMessageWindow → DTO（target null→not-found）。
- **web message-window-store**：加 `hasNewer`/`newestPositionAt`/`newestPositionSeq` + `newerGeneration`；新 `fetchLocatedWindow(api, sessionId, targetId, opts)`（成功→一次性塞窗口+设 cursors+hasMore=hasOlder+hasNewer+hasLoadedLatest=!hasNewer；404→`{ok:false,reason:'not-found'}` 调用方清 saved+fetchLatestMessages）；新 `fetchNewerMessages`（newestPosition cursor；hub `GET /messages` 加 `afterAt/afterSeq` query + store `getMessagesByPositionAfter` 镜像）。merge：locator 种子 + SSE message-received 正常 merge；翻到最新置 hasNewer=false+atBottom=true。
- **web ApiClient**：`locateMessageWindow(sessionId, targetId, opts)`（404 抛 ApiError）。
- anchor 在初始窗口 → restoreScrollAnchor 命中 → 不依赖 loadOlder+ResizeObserver 脆弱循环。

### 4.4 无 saved 滚底

mount 若 saved null → 滚最新（底部）。

### 4.5 跨端阅读位置同步（搬 hub）— 跨层契约

**(a) 捕获语义**（M11）："最后阅读那条消息" = 视口内**首条完全可见**的 agent 消息 messageId。无 agent 消息完全可见→保持上 anchor；视口空→不上报。`observedAt` 跟 messageId 变（同 messageId 不刷新）。scroll 本地 debounce 150ms 写 localStorage；**网络仅** pagehide / `visibilitychange:hidden` / SessionChat keyed cleanup（fetch keepalive）。

**(b) hub 存储 + migration**（L14）：`SCHEMA_VERSION=11`；`migrateFromV10ToV11`（ALTER ADD `last_read_message_id TEXT` + `last_read_at INTEGER`，各 guard 列存在）；`buildStepMigrations[10]`；createSchema sessions 加两列；`migration-v11.test.ts`（fresh 含列 / V10→V11 / V9→V11 多 hop / idempotent / ALTER 各一次）。

**(c) 数据链 5 层**（S2）：
- `store/types.ts StoredSession` + `store/sessions.ts DbSessionRow`+`toStoredSession` 加 `lastReadMessageId`/`lastReadAt`。
- `store/sessions.ts` 新 `setSessionReadPosition(db, id, ns, messageId, observedAt, expectedLastReadAt)`：LWW CAS SQL
  `WHERE id AND ns AND (last_read_at IS NULL OR last_read_at < @observedAt OR (last_read_at=@observedAt AND last_read_message_id < @messageId)) AND (last_read_at=@expectedLastReadAt OR @expectedLastReadAt IS NULL)`；返回 success/stale（changes=0 但 row 存在）/not-found。
- `syncEngine` 新 `getSessionReadPosition(sessionId, ns)` + `updateSessionReadPosition(...)`（成功→refreshSession + `eventPublisher.emit session-read-position`；返 success/stale/not-found）。
- `shared/sessionSummary.ts SessionSummary`+`toSessionSummary` 加两字段；`shared/schemas.ts SessionSchema` 加两 nullable optional。
- `hub/web/routes/sessions.ts POST /sessions/:id/read-position`：body Zod `{messageId, observedAt(>=0), expectedLastReadAt(nullable optional)}`；**observedAt clamp**（future > now+60s → 400 future_ts，S4）；响应 success 200 / stale 409（含 currentUpdatedAt）/ not-found 404。GET /sessions 自动带两字段（toSessionSummary 已映射）。

**(d) LWW clock skew**（S4）：防线1 observedAt clamp（>1min future→400）；防线2 CAS（last_read_at 作 revision + tie-breaker messageId）；stale→客户端合并 hub 当前值（打破两端互写未来死锁）。不变量：observedAt 永远客户端观察时刻；CAS+clamp 保证最坏偏 30s，messageId 仍一致。

**(e) SSE 通路**（S5）：**不动 sseManager**。`syncEngine.updateSessionReadPosition` 成功 → `eventPublisher.emit({type:'session-read-position', sessionId, messageId, updatedAt:observedAt})`（自动注入 namespace，shouldSend 现成过滤）。`shared/schemas.ts SyncEventSchema` 加 `session-read-position` 分支（SessionChangedSchema.extend）。`web/useSSE.ts handleSyncEvent` 加分支：只更 sessions+session cache（LWW，不滚当前 viewport）；不实时拽。

**(f) 客户端上报**：新 `useReadPositionReporter`（pagehide hook）：触发 pagehide/visibility hidden/SessionChat keyed cleanup；fetch keepalive POST；payload `{messageId, observedAt, expectedLastReadAt}`（expectedLastReadAt 从 GET /sessions 或 SSE 维护）；stale 回包→更新本地 lastKnownHubReadAt。

**(g) 恢复**：进入 session 取 hub lastReadMessageId，与本端 saved LWW 较新者，作 §4.3 locator target。进入后不上报（先恢复）。

---

## 5. 协调 pending-inbox-thinking-mask

**thinking-mask 已上线**（commit `e4582c5`，`sessionAttention.ts:14` 当前 `selected||archived` 短路 + permission/input 在 thinking 上）。本 spec **只**：
- 删 `options.selected` 短路（保留 archived + permission/input/thinking 顺序）。
- SessionList：selected 行 suppress（classifier 传 `selected:false` + 渲染层 `selected ? null : rawAttention`）；permission/input 优先 thinking spinner。
- PendingInboxFab：selected 在 actionable 队列 filter（§4.1）。

`classifySessionAttention` 终态：
```ts
if (summary.metadata?.lifecycleState === 'archived') return null
const kinds = summary.pendingRequestKinds ?? []
if (kinds.includes('permission')) return { kind: 'permission' }
if (kinds.includes('input')) return { kind: 'input' }
if (summary.thinking) return null
if (summary.active && (summary.backgroundTaskCount ?? 0) > 0) return { kind: 'background' }
if (summary.updatedAt > options.lastSeenAt) return { kind: 'unread' }
return null
```

---

## 6. 改动清单

**web**：`sessionAttention`（删 selected）· `SessionList`（suppress+优先）· `PendingInboxFab`（actionable 队列）· 新 `pending-since-store` · `chat-scroll-store`（raw messageId）· `message-window-store`（hasNewer/fetchLocatedWindow/fetchNewerMessages）· `HappyThread` · `useSSE`（session-read-position 分支）· 新 `useReadPositionReporter` · **`api/client.ts`（locateMessageWindow + postReadPosition，归 web）**。

**hub**：`store/index.ts`（SCHEMA_VERSION=11 + migrateFromV10ToV11 + createSchema 加两列 + buildStepMigrations[10]）· `store/sessions.ts`（DbSessionRow+toStoredSession+setSessionReadPosition）· `store/messages.ts`（locateMessageWindow + getMessagesByPositionAfter）· `syncEngine`（getSessionReadPosition+updateSessionReadPosition+locateMessageWindow getter+emit）· `web/routes/sessions.ts`（POST /read-position）· `web/routes/messages.ts`（GET /locate + afterAt/afterSeq）。

**shared**：`schemas.ts`（SessionSchema 两字段 + SyncEventSchema session-read-position 分支 + ReadPositionRequestSchema + MessageLocateQuery/ResponseSchema）· `sessionSummary.ts`（SessionSummary+toSessionSummary 两字段）· `apiTypes`（DTO）。

**所有权约定**：`web/src/api/client.ts` 仅 web；shared 只 Zod schema + DTO type。

---

## 7. 验证

### 7.1 Goal A 机械（本地）
`bun typecheck && bun run test && bun run build:web`
- `sessionAttention.test`（§5 终态：selected 不再短路 + permission/input 无视 thinking + unread/background 被 thinking 压）。
- `pending-since-store.test`（reconcile 首帧原子：空 store→全 now；已有→不变）。
- `SessionList` 测试（selected suppress + permission/input 优先 spinner）。
- `migration-v11.test`（fresh 含列 / V10→V11 / V9→V11 / idempotent / ALTER 各一次）。
- saved 恢复（locator 命中 / 无 saved 滚底）。
- **locator 三层测**（M10）：
  - store：locateMessageWindow（中间 / 边界 / 不存在 / 属别的 session / limit 边界）。
  - route：GET /locate（200 / session 404 / message 404 / 非 uuid 400 / limit clamp）。
  - web mock：fetchLocatedWindow（状态设置 / 404 清+回退 / fetchNewer 合并 / 竞态 guard）。
- 跑顶回归（空批/高度不变 → saved-anchor 恢复仍进展或终止）。

### 7.2 手测（双端）
| 路径 | 期望 |
|---|---|
| 电脑在 Y、手机在 X、队列 [Y,Z]；Z 完成 | Z 追加末尾不插队；两端点红点跳 Y ✅ |
| 手机点红点进 Y | 落到电脑正在看的位置（hub 水位）✅ |
| 看过的 session 切走再回 | 回到上次位置，不跑顶 ✅ |
| 没看过的 session 首次进 | 滚到最新 ✅ |
| 当前 session | 不画自己 dot；点 FAB 不跳自己 ✅ |
| 单端使用 | 行为不回归 ✅ |

### 7.3 Goal B 机械（部署）
见 Goal Contract Goal B Observable completion（4 门 + 回滚）。

---

## 8. 已知边界（M12 Outcome 收窄）

**保证**：阅读 anchor 跨端一致（CAS LWW 收敛）；单端 pending 顺序稳定；两端 pending 集合+顺序+selected 相同 → FAB 目标一致。
**不保证**：selected 不同→FAB 目标不同；点击单端消窄边界；像素一致；LWW 竞态（CAS-stale 回合并打破）；排序 per-device。

---

## 9. 不做

红点水位不搬 hub · 不做发送跨端消红点 · 不加标记已处理 · 不同步像素/不逐 scroll 上报/不实时拽 · 不动 Telegram memory / 不改 SessionList 整体顺序 / 不动 sseManager / 不碰 CLI thinking（thinking-mask 已上线）。

---

## 10. 可选扩展

发送跨端消红点（将来，需 hub 共享 handled + 过滤 scheduledAt==null）· hub-issued monotonic revision（若 clock-skew 多，last_read_at 改 read_position_version；当前防线1+2 够，不上）。
