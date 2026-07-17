# hapi fork 定制改动 — 规格（合并版）

> fork: `veniai/hapi` · 工作目录 `/home/claw/projects/hapi` · 基于上游 tag `v0.22.3` · 分支 `feat/manual-scroll`
> 本文件合并了原 `customizations.md`（修复A + 六项改动）、`resume-flow.md`（远程恢复链路）、`customizations-verify.md`（核查结论 + Codex 交叉审查）。
> 状态：**计划已定 + 已核查 + Codex 交叉审查完成，准备实现**。代码尚未改动。
> 核查基准：`work/current` 分支 working tree（2026-07）。结论格式：✅ 已确定 / ⚠️ 需运行时实测。

---

## 贯穿原则

- **`thinking=true` 的会话（正在跑、含等子 agent）一律不打扰**——不标红点、不进浮窗、不发限时 toast、不误判结束。所有「打扰用户」类改动的统一短路。
- 先在 dev 验证，满意后再出二进制、再 push。
- 复用现有判定 / 游标 / 样式，不重造轮子。

---

## 主链路（所有优化服务的锚点）

> **收到钉钉通知 → 手机打开 → 点待处理浮窗 → 页面定位到「上次阅览处 = 第一条未读」**

四个环节、四个诉求：远程（公网 + Cloudflare）、移动（锁屏/亮屏）、冷启动或重连、快速定位到该看的位置。

---

## 实现路线图

### 依赖图（→ = 前置）

```
L0.2 markSessionSeen 门控 ──┬─→ L1.2 红点响应性
                            ├─→ L1.3 浮窗响应性
                            └─→ L3.1 第一条未读定位
L1.1 改动一(滚动·无争议) ────→ L3.1（同改 HappyThread，基于其结果）
L1.3 浮窗 ──────────────────→ L3.2（浮窗联动定位）
L2.1 钉钉 ──────────────────→ L3.3（通知 deep link）
[无前置] L0.1 修复A / L0.3 性能三件套 / L2.2 靠边 / L2.3 reasoning
```

### 批次表

| 批次 | 项 | 前置 |
|---|---|---|
| **L0 · 解锁层** | L0.1 修复A(ctx) · L0.2 markSessionSeen 门控 · L0.3 性能三件套 | 无（互相独立，可并行） |
| **L1 · 前端主体** | L1.1 改动一(滚动·无争议) · L1.2 改动二(排序+红点) · L1.3 改动三(浮窗) | L0.2（红点/浮窗响应性） |
| **L2 · 收尾** | L2.1 改动四(钉钉) · L2.2 改动五(靠边) · L2.3 改动六(reasoning) | 无强前置 |
| **L3 · resume 专项** | L3.1 第一条未读 · L3.2 浮窗联动 · L3.3 deep link | L0.2 + L1 |

### 共享实现点（跨项统一，勿各搞一套）

- **lastSeenAt / markSessionSeen**：抽共享 `useSessionLastSeen` hook（含版本号订阅 + storage listener），SessionList（L1.2）、浮窗（L1.3）、定位（L3.1）共用。门控在 L0.2 一次做掉。
- **attention 判定口径（两套，勿混）**：
  - **前端**：L1.3 浮窗用 `permission` / `input` / `unread`（排除 `background`）；L1.2 列表只用 unread 判定（时间文字变红，不走 attention 体系）。
  - **hub 钉钉**（L2.1）：`permission` / `input` / `error` / `completed`，**无 unread**（hub 无 lastSeenAt 概念 + AFK 刷屏）——是 hub notification event 口径，与前端 attention 不同源。

---

## goal 模式使用说明

本 spec 按 **Claude Code `/goal`**（自主工作 + 每轮 evaluator 检查 done）组织。用法：

- **每项一个 goal**（不是整个 spec 一个 goal），按 L0 → L1 → L2 → L3 顺序推进。
- 喂 `/goal` 时引用本 spec 的某一项，目标 = 该项「目标 + Done 条件」；agent 须遵守「硬约束/陷阱」、限于「文件范围」。
- 「人工步骤」和「待实测项」是 `/goal` 做不了的（需抓包 / dev 体感 / 真实收信），由人工补。

---

# L0 · 解锁层（无前置，可并行）

## L0.1 · 修复A · ctx 读数恒 0（GLM 等 Anthropic-compatible 供应商）

**目标**：GLM 等供应商状态栏 ctx 读数恒为 0（`ctx 0/1000000 (0%)`）→ 正确显示。

**方案（append-only）**：轮次 `result` 到达时多发一条「空 content + 真实 usage」的 assistant 载体消息，走现有 `sendClaudeSessionMessage` 队列正常落库；前端 reducer 反向扫描自动命中它驱动 ctx，空 content 经 normalizeAgent 产 0 block 不渲染成气泡。
- 根因：GLM 的 SSE `message_delta` 只回占位假值，真实 token 只在 `result` 里；`sdkToLogConverter.ts` 的 result 分支（L342）只缓存 `modelUsage.contextWindow`（L357-367）、**从不引用 `result.usage` token、不产 logMessage**（convert(result) 返回 null，L414）；落库 assistant 消息永远 `usage:{0,0}`。
- 改动：①`sdkToLogConverter.ts` 加 `buildUsageCarrier(usage)`——由 `result.usage` 构造 `{type:'assistant', content:[], message:{usage:{input,output,cache_read,cache_creation,context_window?}}, parentUuid: this.lastUuid, ...}`，复用 `resolvedContextWindowKey`/`modelContextWindows` 缓存；②`claudeRemoteLauncher.ts` onMessage 内、`convert(msg)`(L191) 之后、`if(logMessage)`(L192) **之外**，加 `if (message.type==='result' && r.subtype==='success' && r.usage) enqueue(buildUsageCarrier(r.usage))`。

**前置依赖**：无。

**硬约束/陷阱**（任一踩中即方案失败）：
1. **放置陷阱**：carrier 的 enqueue **必须在 `if(logMessage)` 块外**——convert(result) 返回 null，块内永不触发。
2. **队列过滤**：carrier 必须 `type:'assistant'`，**不可**加 `isMeta` / `isCompactSummary`（`OutgoingMessageQueue.ts:124` 会静默吞掉、不落库）。
3. **content 类型**：必须**显式 `[]`**——不能省略（不合 `RawMessageSchema` 的 `content: z.unknown()`，`cli/src/claude/types.ts:21`），绝不能用 `""`（`normalizeAgent.ts:238` 的 `typeof==='string'` 分支会发成空文本气泡）。
4. **排序约束**：载体须**晚于其后所有可见且带 usage 的消息**——本轮那些 `{0,0}` 的流式 assistant 也带 usage（`asNumber(0)===0`、`0!==null`），载体必须晚于它们，否则被 reducer 反向扫描覆盖、ctx 归 0。靠队列按 id 顺序保证（result 是轮次终点，常规成立）。
- 核查利好：carrier 不经 convert ⇒ lastUuid 不污染 parent chain；无 localId ⇒ addMessage 走 `invokedAt=now` 直接落库（期望）；`context_window` 不被 schema 剥离（socket/落库不经 UsageSchema）。

**文件范围**：`cli/src/claude/utils/sdkToLogConverter.ts`、`cli/src/claude/claudeRemoteLauncher.ts`（+ 对应 `.test.ts`）、`web/src/chat/reducer.test.ts`（reducer 单测在 web 侧）。

**Done 条件**：
- converter 单测：`buildUsageCarrier` 返回合法 RawJSONLines（type=assistant、content=`[]`、usage 字段齐、parentUuid 接 `this.lastUuid`、**不更新 lastUuid**——保持 parent chain 干净，后续真实消息仍指本轮最后一条真实 assistant）；缓存有值带 context_window、空则不带。
- launcher 单测：`result(success+usage)` → enqueue 恰一条载体，且**不依赖 `if(logMessage)` 命中**（验证放置陷阱已规避）；`result(error_*)`/无 usage → 不发。
- reducer 单测：消息集含一条 `content=[] + usage` 的 assistant → `latestUsage` 取自它、`blocks` 不含它。

**验证命令**：`bun run typecheck:cli && bun run test:cli` + `bun run test:web`（reducer 单测）。

**人工步骤**：✅ **GLM 运行时语义已实测确认**（2026-07，`claude -p --output-format stream-json` 连 GLM）：
- result 带真实 usage（非 `{0,0}`）：单轮 `13411/3/14784`、多工具轮(num_turns=3) `41402/101/18304`。
- `result.modelUsage` 带 `contextWindow: 1000000`，key = `glm-5.2[1m]`（= `resolvedContextWindowKey`，carrier 能命中，**不会 "N/null"**）。
- 流式 assistant usage 确为 `{0,0}` 占位（印证根因）。
- 多工具轮 contextSize ≈ 59706（~6% ctx），量级像 **last-call**（ctx 显示准确、非偏高）；未 100% 排除累计，但不阻断——落地后看实际 ctx 显示是否偏高再定。

---

## L0.2 · markSessionSeen visibility 门控（新增项）

**目标**：用户锁屏/切走但 PWA 活着时，`lastSeenAt` 不被 SSE 推送的 `updatedAt` 持续推到最新——保证 AFK 返回能定位未读 + 红点响应性正确。这是 L1.2/L1.3/L3.1 的共同前置。

**方案**：
- `router.tsx` markSessionSeen effect（L216-221，当前依赖 `[selectedSessionId, selectedSession?.updatedAt]`、无 visibility 检查）加 `visibilitychange` 门控：仅 `document.visibilityState==='visible'` 时 `markSessionSeen`，hidden 时冻结。
- 抽共享 `useSessionLastSeen` hook：①版本号 state；②订阅两个源——**跨 tab** `storage` event listener + **同 tab** `markSessionSeen` 后主动通知（派发自定义事件 / bump 版本号，因 `storage` event 不在执行 setItem 的当前 tab 触发）；SessionList / 浮窗 / 定位共用。SessionList 只在列表层订阅一次并将水位传给各行，不得每行注册全局事件。
- **水位时序契约（与 L3.1 共同遵守）**：进入/恢复会话时**先快照旧 lastSeenAt 用于定位，定位确认可见后才 markSessionSeen 推进到最新**——否则 visible 恢复/导航进入瞬间推进水位会让"第一条未读"消失。具体实现见 L3.1（`locateSettledFor` + `visibilitychange`）。
- 红点（L1.2）继续用会话级水位（够用）；resume 定位（L3.1）用同一水位 + 门控。

**前置依赖**：无（但解锁 L1.2 / L1.3 / L3.1）。

**硬约束/陷阱**：
- `markSessionSeen` 单调 `Math.max`（`sessionLastSeen.ts:58`），门控只加 visibility 检查、不改水位语义。
- **`storage` event 不在当前 tab 触发**（仅跨 tab）——hook 必须额外监听同 tab `markSessionSeen` 的主动通知，否则本 tab 写水位后红点/浮窗不即时更新。
- 跨 tab 须补 `storage` listener（他 tab 改水位本 tab 感知），否则多 tab 水位不一致。
- SessionList 选中/取消选中路径会触发 memo 重算；浮窗必须另外识别当前路由，不能将 `selected` 恒置为 false，否则重复点击会被同一会话挡住。

**文件范围**：`web/src/router.tsx`、`web/src/lib/sessionLastSeen.ts`（+ 新 `useSessionLastSeen` hook，建议放 `web/src/hooks/`）。

**Done 条件**：
- 单测：hidden 期间 SSE 推新消息不推进 lastSeenAt；visible 时正常推进（**且在定位完成后**，见时序契约）；**同 tab** markSessionSeen → hook rerender；跨 tab storage 事件更新版本号。
- `typecheck:web` 通过。

**验证命令**：`bun run typecheck:web && bun run test:web`。

**人工步骤**：多 tab + 锁屏场景手动验证水位冻结；AFK 返回红点/未读仍可定位。

---

## L0.3 · 远程性能三件套（来自 resume-flow 环节2）

**目标**：远程/移动端亮屏打开快——消除 10s `NetworkFirst` 等待、亮屏重连退避、孤儿 GC。是「快速打开」的基础设施。

**方案**（按性价比，先 SW）：
1. **SW 短超时 `NetworkFirst`**（`web/src/sw.ts`，会话列表/详情/机器）：最多等待网络 2s，超时才回退缓存。不用 `StaleWhileRevalidate`，避免已归档会话或旧 pending 状态先回到 UI；SSE 继续负责实时更新。
2. **亮屏立即重连 + 重置退避**（`web/src/hooks/useSSE.ts` `onVisibilityChange` ~L599）：visible 且 SSE stale 时立即 `requestReconnect` 并 `reconnectAttempt=0`，不等累积 backoff（`BASE=1s`×2^attempt，`MAX=30s`，L43-45/207）。
3. **孤儿 GC**（`web/src/lib/message-window-store.ts`）：会话从 hub 删除后 web sessionStorage 的 `hapi:message-window:v1:*` 不清理（实测 5 个孤儿 ~4.5MB 撑爆配额）。**唯一 owner**：抽 `gcMessageWindows(validSessionIds)` helper（放 message-window-store.ts），由 `useSessions`（router.tsx:177 SessionsPage 那处）拿列表后调一次——勿在 share/NewSession 的 useSessions 也调（避免重复扫描）。

**前置依赖**：无。

**硬约束/陷阱**：
- SW 缓存不得以旧状态作为联网时的首个响应；网络不可用时仍允许回退缓存。
- 孤儿 GC 只清 `hapi:message-window:v1:*` key，勿动其他 sessionStorage 项。

**文件范围**：`web/src/sw.ts`、`web/src/hooks/useSSE.ts`、`web/src/lib/message-window-store.ts`（+ `gcMessageWindows` helper）、`web/src/router.tsx`（SessionsPage 的 useSessions 处调 GC，~L177）。

**Done 条件**：
- SW 策略对象改为 SWR；亮屏重连单测（visible+stale → 立即重连、attempt=0）；孤儿清理单测（`gcMessageWindows` 仅清列表外 key、保留在列的）。
- `typecheck:web` 通过；`bun run test:web` 通过。

**验证命令**：`bun run typecheck:web && bun run test:web` + `bun run test:e2e`（远程+移动场景）。

**人工步骤**：远程 + 移动亮屏计时；孤儿占内存实测（清理前后）。

---

# L1 · 前端主体（前置 L0.2）

## L1.1 · 改动一 · 聊天滚动（无争议部分）

**目标**：AI 流式回复期间页面停在用户阅读位置；按回车发送滚到底。（「第一条未读」定位移到 L3.1。）

**方案**：
1. **关自动跟随**：
   - `ResizeObserver` 回调（L620-631）改为只重算并同步 `atBottom`/`autoScroll`——新增 `recomputeAtBottom`，用 `getScrollIntent`（L47）算位置 + 复用 `setAtBottomMode`/`setAutoScrollMode`（L357-373，需提取为 `useCallback`）写两个 ref，**不调** `scrollToBottomInstant()`。observer 本体保留（仍 observe contentRef）。
   - `messagesVersion` 的 `useLayoutEffect`（L636-657）：去掉「在底部就滚」分支（L654-656），只留 `pendingScrollRef`（加载历史保位）分支。
2. **发消息滚到底**：`forceScrollToken` effect（L497-503）保持 smooth `scrollToBottom()`（L502），加真 `setTimeout` 多段补滚（常量 `SEND_FOLLOWUP_SCROLL_DELAYS_MS = [0,200,500]`），独立 timer ref，切会话/卸载清理。不引入 `pendingSendScrollRef` / MutationObserver。

**前置依赖**：无（与 L0.2 无关；「第一条未读」部分依赖 L0.2，归 L3.1）。

**硬约束/陷阱**：
- **两滚动函数不可混用**：`scrollToBottomInstant`（L414-420，instant，纯滚动无副作用）用于关跟随处；`scrollToBottom`（L423-435，smooth，滚动 + 置 autoScroll/atBottom + flush）用于发消息/按钮。关跟随处误用 smooth 会改 atBottom/autoScroll 状态；发消息误用 instant 会丢 smooth + flush。
- `setAtBottomMode`/`setAutoScrollMode` 必须锁步更新两个 ref，不可只写 `atBottomRef`（否则 guard 漏判、pending 不 flush）。
- 切会话初始滚到底（L453-488）是独立机制，勿误伤。
- 行号修正：依赖数组实为 **L657**（旧 spec 标 ~L571 偏移）。

**文件范围**：`web/src/components/AssistantChat/HappyThread.tsx`（唯一）。

**Done 条件**：
- 单测：ResizeObserver 不再自动滚；发消息多段补滚；messagesVersion 去掉「在底部就滚」分支。
- `typecheck:web` 通过。

**验证命令**：`bun run typecheck:web && bun run test:web`。

**人工步骤**：dev（web :5173 代理 hub :3006）手动验证：AI 长回复不跟；发消息滚到底；切会话/回到底部按钮/大纲跳转/加载历史保位均正常。

---

## L1.2 · 改动二 · 列表固定排序 + 未读红点

**目标**：列表纯 `createdAt` 固定排序（去 active/pending/hasActiveSession 优先，正在跑的会话不再靠前）+ 未读红点（thinking 会话不亮）。

**方案**：
1. **createdAt 字段**：`shared/src/sessionSummary.ts` 的 `SessionSummary`（L43-63，当前无）加 `createdAt: number`；`toSessionSummary`（L108-151）透传 `session.createdAt`（`Session` schema 已有，`schemas.ts:212`）。web 侧经 `types/api.ts`（L60 再导出）自动透到前端。
2. **6 处排序键 `updatedAt→createdAt` + 去 active/pending/hasActiveSession 优先**：
   - 后端 `hub/src/web/routes/sessions.ts:72-85` → 单一 `b.createdAt - a.createdAt`。
   - SSE 缓存 `web/src/hooks/useSSE.ts:48-56` `sortSessionSummaries` → 单一 `right.createdAt - left.createdAt`（L316/L354 共用）。
   - 侧边栏 `web/src/components/SessionList.tsx`：去重 tiebreaker L140-147（L146 改 createdAt，**保留** active/selected 选择语义）、项目组内 L215-224（去 L216-217 rank、L219 改 createdAt、latestUpdatedAt→latestCreatedAt）、项目组间 L238-243（去 L239-241 hasActiveSession、L242 改 latestCreatedAt）、机器组 L269-297（去 L294 hasActiveSession、latestUpdatedAt→latestCreatedAt）。注：L282 `totalSessions:0` 与本改动无关。
3. **未读标记 = 时间文字变红**（替代新增红点）：`SessionList.tsx:730` 已渲染 `getSessionTimeLabel(s, t)`（相对时间「X 分钟前」，standard 模式常驻显示）。给它加条件 className：**未读时红**（`s.updatedAt > lastSeenAt && !s.thinking && s.id !== selectedSessionId`）、否则原色。`lastSeenAt` 用 L0.2 的 `useSessionLastSeen` hook（响应性 + 跨 tab）。
   - **不改 attention 体系**：不动 attention useMemo 门控（L655-663）、不动 `SessionAttentionIndicator`、不动「Pending N」药丸（L724）。permission/input 仍仅 detailed 模式显示，需要处理由浮窗（L1.3）/钉钉（L2.1）覆盖。
   - 职责更清晰：列表=未读（时间红）；浮窗+钉钉=需要处理。
4. **药丸无需改**（原方案因放出 unread 会压药丸才需改按 kind；本方案不碰 attention，药丸 `!attention` 条件不受影响）。

**前置依赖**：L0.2（时间红的 lastSeenAt 响应性依赖门控 + 共享 hook）。

**硬约束/陷阱**：
- 去重 tiebreaker（L140-147）是「选哪条副本显示」、不是列表排序，**保留** active/selected 优先合理。
- 时间红须排除 `thinking` 会话 + 当前 selected 会话（沿用 `sessionAttention.ts:13` 的 `selected || thinking` 短路语义）。
- `getSessionTimeLabel` 可能返回 null（codex 导入等场景），null 时不加颜色类。

**文件范围**：`shared/src/sessionSummary.ts`、`hub/src/web/routes/sessions.ts`、`web/src/hooks/useSSE.ts`、`web/src/components/SessionList.tsx`。（**不再改** `SessionAttentionIndicator.tsx`。）

**Done 条件**：
- 单测：createdAt 排序（新建/触发更新不跳顶）；时间未读红/已读原色（`updatedAt>lastSeenAt` 红、点开/thinking/selected 原色）。
- `bun run typecheck`（全）通过。

**验证命令**：`bun run typecheck`（全 cli+web+hub；shared 随消费者覆盖）+ `bun run test:web`。

**人工步骤**：新建/触发更新 → 顺序不变 + 时间变红；点开 → 时间恢复原色；正在跑会话时间不变红。

---

## L1.3 · 改动三 · 待处理会话浮窗

**目标**：全局待处理浮窗（permission/input/unread 计数，点跳转逐个清理，清空消失）+ 去掉 ready/permission 限时闪现（Task completed/failed 保留）。

**方案**：
1. **新组件** `web/src/components/PendingInboxFab.tsx`，挂**根 App**（AppInner，与 `<Outlet/>` L450 / `<ToastContainer/>` L452 同级），落在认证后分支（App.tsx L435，认证前提前 return），自行 `useSessions(api)`（`queryKeys.sessions` 去重，不重复请求）。
2. **数据源 = attention 判定**（非 toast 队列）：从 `useSessions` 中先排除已归档/非活跃会话和当前会话，再**按 kind 筛 permission/input/unread**（排除 background）后计数。
3. **交互**：点击 → 导航第一个待处理会话（`/sessions/$id`）；导航后当前会话退出队列，下次点击可继续下一个。**unread 须定位+确认可见后才清**；permission/input 在离开会话后会重新进队，直到 agent 真正移除 `pendingRequestKinds`。空 → 隐藏。
4. **去限时闪现**：`App.tsx` `handleToast`（L307）对 `Ready for input`/`Permission Request` 不再 `addToast`；`Task completed/failed` 仍走限时 toast（`toast-context.ts:19` `TOAST_DURATION_MS=6000`）。

**前置依赖**：L0.2（依赖共享 lastSeen hook 的响应性）。

**硬约束/陷阱**：
- **不能**复用 SessionList 的 attention 字段（被 `showDetailedStatus` 门控，standard 模式恒 null）——必须自行 classify。已归档会话即使保留旧 `updatedAt`/request 也不得进队。
- attention 口径与 L1.2 一致（前端 permission/input/unread 排除 background）；L2.1 钉钉是 hub 侧独立口径（见共享点），不复用前端 attention。
- last-seen 订阅用 L0.2 共享 hook（别在浮窗和 SessionList 各加一份版本号）。

**文件范围**：新增 `web/src/components/PendingInboxFab.tsx`、`web/src/App.tsx`。

**Done 条件**：
- 单测：浮窗计数（permission/input/unread 各类）；跳转 + 逐个清理；空则隐藏；等子 agent 会话不进浮窗。
- `typecheck:web` 通过。

**验证命令**：`bun run typecheck:web && bun run test:web`。

**人工步骤**：有待处理 → 浮窗显示数字；点跳转逐个清理；清空消失；等子 agent 会话不进浮窗；`Ready for input`/`Permission Request` 不再 6s 闪现（`Task completed/failed` 仍闪）。

---

# L2 · 收尾（无强前置）

## L2.1 · 改动四 · 钉钉通知（event 驱动 + cc-monitor 文案）

**目标**：「需要我处理就通知」——按 hub notification event（permission 待审批 / input 等输入 / error 出错 / completed 完成）发钉钉，cc-monitor 风格无标题文案。

> **诚实语义（Codex 修正）**：这是 **ready/task/permission event 驱动**，不是纯 attention 驱动——hub 的 `ready` 事件在 abort/失败/异常后**也发**（`apiSession.ts:813-840` payload 固定 `{type:'ready'}`，hub 无法区分 outcome）。故 `sendReady` 文案只能用「空闲/等待输入」，**不能用「完成」**（abort 后报"完成"是误导）；真正的「完成」走 `sendSessionCompletion`/`sendTaskNotification(success)`。不推 unread（hub 无 lastSeenAt）。

**方案**：
1. **新渠道** `hub/src/dingtalk/`（与 `hub/src/serverchan/`、`hub/src/telegram/`、`hub/src/push/` **平级，不在 `notifications/` 下**），`implements NotificationChannel` 四方法：
   - `sendPermissionRequest(session)` →「待审批」，预览 `session.agentState.requests[id].tool` + arguments。
   - `sendReady(session)` → **「空闲/等待输入」**（非"完成"），注入 store 取最近消息前 60~80 字。
   - `sendTaskNotification(session, n)` → `n.status=failed`→「失败」/else→「完成」，预览用 `n.summary`。
   - `sendSessionCompletion(session, reason)` →「完成」，注入 store 取最近消息。
2. **文案** `{项目名}·{状态}{消息预览}`，项目名 `getSessionName(session)`（`sessionInfo.ts`）；去掉 cc-monitor 的 `C·`/`**[Claude]**` 标题前缀。
3. **消息预览取数**：channel 注入 `store`（仿 `HappyBot` `bot.ts:39-40`、`startHub.ts:209-214`），用 `store.messages.getMessages(sessionId, N)`（`messages.ts:150`，末元素最新）；文本提取复用 `extractUserMessageText`。
4. **helper 导出（必须，Codex 修正）**：`formatToolArgumentsDetailed`（`telegram/sessionView.ts:163`）和 `extractUserMessageText`+`normalizeUserMessageText`（`syncEngine.ts:102`）当前都**私有**——抽到公共 helper（如 `hub/src/util/toolFormat.ts` + 在 syncEngine export 两个函数），telegram/钉钉共用；钉钉跨目录 import telegram 私有函数不可行。
5. **冷却**：复用 hub `readyCooldownMs`（5s、per-session、全渠道共享、`notificationHub.ts:158`），不自实现。
6. **配置注册面三处**（env>file>default）：`serverSettings.ts`、`configuration.ts`、`settings.ts` 加 dingtalk 字段；secret 沿用既有约定（明文 settings.json、不入 git、目录 0o700）。
7. **装配**：`startHub.ts:199-221` guard（`config.dingtalkWebhook && config.dingtalkNotification`），构造注入 store + token；`new NotificationHub` L221。
8. **发送协议**：webhook + 可选 HMAC-SHA256 签名（`timestamp + "\n" + secret` → HMAC-SHA256 → base64 → urlencode）+ 关键词过滤。**payload 用 `msgtype:"markdown"`**（非 text——为支持 L3.3 可点链接，text 不支持 markdown 链接）。Web Crypto / Node crypto。

**前置依赖**：无强前置（hub 独立；event 口径 hub 自实现，与前端 attention 不同源，见共享点）。

**硬约束/陷阱**：
- **hub 无法区分 ready outcome**——`sendReady` 文案禁用「完成」，只用「空闲/等待输入」。
- session 异常结束（`reason='error'|'terminated'`）当前 hub 静默（`notificationHub.ts:59` 只放行 completed）、无 cause 文本——本轮不覆盖；要覆盖需协议层加字段。
- 渠道路径：钉钉建 `hub/src/dingtalk/`（平级），勿放 `notifications/` 下。
- 复用的两个 helper 必须先抽公共/导出，否则跨目录 import 编译失败。

**文件范围**：新增 `hub/src/dingtalk/`；`hub/src/startHub.ts`、`hub/src/config/serverSettings.ts`、`hub/src/configuration.ts`、`hub/src/config/settings.ts`；抽 `hub/src/util/toolFormat.ts`（含 `formatToolArgumentsDetailed`）+ `hub/src/sync/syncEngine.ts`（export `extractUserMessageText`/`normalizeUserMessageText`）；`hub/src/telegram/sessionView.ts`（改 import 公共 helper）。

**Done 条件**：
- 单测：钉钉四方法（mock fetch）；HMAC 签名；文案（项目名·状态+预览、无标题、**ready 用"空闲/等待输入"**）；helper 抽取后 telegram 原行为回归不变。
- **集成测试（Codex 修正）**：`startHub` 条件装配（webhook+notification 满足才注册钉钉）；配置优先级（env>file>default）；NotificationHub 扇出（ready 事件 → 钉钉 sendReady）。
- `bun run typecheck:hub && bun run test:hub` 通过。

**验证命令**：`bun run typecheck:hub && bun run test:hub`。

**人工步骤**：配 webhook/secret/keyword；真实钉钉收信验证各状态文案（待审批/空闲/完成/失败）；**确认 abort 后收到的是"空闲"非"完成"**。

---

## L2.2 · 改动五 · 左侧会话列表靠边对齐

**目标**：sidebar 调宽后内容贴边（去居中留白），三层树在保留层级的同时减少累计左缩进。

**方案**：去掉 3 处 `mx-auto w-full max-w-content`；列表实际内容的外层 padding 收到 4px，project/session 两层各保留 8px 缩进，不再叠加多余 `pl-1`。

**前置依赖**：无。

**硬约束/陷阱**：
- 只改 sidebar 自身宽度和层级缩进；SessionChat/SessionHeader/HappyThread 等的主内容区居中是**正确的**，不能动。
- **勿改** `tailwind.config.ts:7-9` `maxWidth.content` 定义（否则破坏主内容区居中）。
- **勿破坏** `desktop-scrollbar-left` 的 rtl/ltr（`index.css:357-363`）。
- 纯桌面端（≥1024px）问题。

**文件范围**：`web/src/router.tsx`、`web/src/components/SessionList.tsx`。

**Done 条件**：`typecheck:web` 通过；diff 确认仅改 `router.tsx:486/532` + `SessionList.tsx:1022` 三处（目标 `mx-auto w-full max-w-content` 在这三节点消失、其余 25 处计数不变）。

**验证命令**：`bun run typecheck:web`。

**人工步骤**：≥1280px 视口拖宽 sidebar 复现居中留白 → 确认去掉后贴边；1024–1279px 区间同理。

---

## L2.3 · 改动六 · reasoning 只在点击时展开

**目标**：reasoning 默认折叠，仅点击 header 展开/收起。

**方案**：删 `reasoning.tsx` L67-71 的 useEffect（`if(isStreaming) setIsOpen(true)`、无 false 路径）；清 L1 import 死代码——L1 改为 `import { useState, type FC, type PropsWithChildren } from 'react'`（`useEffect` 仅被 L67-71 用，删后成死代码）。

**前置依赖**：无。

**硬约束/陷阱**：
- 保留 `ShimmerDot`（L86-90，isStreaming 时显示「正在思考」）；`Reasoning`（L44-57）不动。
- tsconfig 未启 `noUnusedLocals`（死 import 不报错但仍应清）。
- 行为变化：之前「流式开始展开、结束后保持展开」；之后「一律初始折叠、仅点击展开」——这是目标行为。

**文件范围**：`web/src/components/assistant-ui/reasoning.tsx`（唯一消费方 `AssistantMessage.tsx` 无需改）。

**Done 条件**：单测：初始折叠；点击展开/收起；流式时不自动展开。`typecheck:web` 通过。

**验证命令**：`bun run typecheck:web && bun run test:web`。

**人工步骤**：dev 验证 reasoning 流式时折叠、点击展开、ShimmerDot 仍显示。

---

# L3 · resume 专项（前置 L0.2 + L1）

## L3.1 · 环节4 · 第一条未读定位

**目标**：切会话/打开会话定位到**第一条未读**（非最新），含并发硬约束（AFK 回来定位最早的未读）。

**方案（重写，Codex 修正：原 `locateOutlineTargetMessage` 要已知 ID，不支持边加载边找）**：
1. **新增兄弟 helper** `locateFirstUnreadMessage`（`HappyThread.tsx`，`locateOutlineTargetMessage` 旁）——用**谓词回调** `findFirstUnreadTargetId()` 代替已知 ID：每次 `loadOlderPreservingScroll()` 后重扫，返回 `${kind}:${id}` 或 null；`while (!targetId && hasMoreMessages())` 循环往前翻直到命中。≤50 条未读直接命中当前窗口，>50 条才翻页。
2. **SessionChat 算目标 ID**（新增，`SessionChat.tsx` ~L968）：`firstUnreadTargetIdRef` = 扫 `visibleBlocks`（sidechain 已折叠进 tool-call children，天然跳过）找第一条 `block.createdAt > lastSeenAt`，返回 `${block.kind}:${block.id}`；全已读/无 lastSeenAt → null（走滚到底）。**normalized/blocks 在 SessionChat 生成（L889-942），HappyThread 自己拿不到**（props 只有数量/version/outlineItems），故必须 SessionChat 算、用 ref 传下（让 load 循环每次读最新值）。
3. **HappyThread 触发**（新增 effect，紧邻 L453-488 初始滚动）：条件 `!isLoadingMessages && rawMessagesCount>0 && 首次`；**必须等 `INITIAL_SCROLL_SETTLE` 结束**（settling 期间 `loadOlderPreservingScroll` L510 return false、sentinel L597 continue，禁分页）；`const target = await locateFirstUnreadMessage({...}); target ? target.scrollIntoView({block:'start'}) : scrollToBottom()`；完成调 `props.onLocateSettled?.()`；上滑取消复用 `shouldCancelInitialScrollSettling`。
4. **新 props**：SessionChat → HappyThread 传 `findFirstUnreadTargetId: () => firstUnreadTargetIdRef.current` + `onLocateSettled?: () => void` + `lastSeenAt: number`。
5. **水位时序（与 L0.2 共同，核心）**：`router.tsx` AppInner 内——`locateSettledFor` state（按 session 重置）；markSessionSeen effect 加双门控 `visibilityState==='visible' && locateSettledFor===selectedSessionId`（定位完成前不推进）；SessionChat 定位完成回调 `onLocateSettled` → router 才 `markSessionSeen`。`visibilitychange`：visible 时重置 `locateSettledFor=null` 允许重新定位。两触发源：导航进入（selectedSessionId 变）、hidden→visible 恢复。
6. 无未读（null）→ 滚到底。定位后 AI 回复**不跟随**（与 L1.1 一致）。

**前置依赖**：L0.2（markSessionSeen 门控 + 时序契约）+ L1.1（同改 HappyThread，基于其结果）。

**硬约束/陷阱**：
- **不能用 INITIAL_SCROLL_SETTLE tick**（settling 期间禁分页）——必须用新 `locateFirstUnreadMessage` load-until-found，且**等 settling 结束**才触发。
- `firstUnreadTargetId` 用 `createdAt`（数值 ms，与 `lastSeenAt` 同源）不用 `agentTimestamp`（跨机时钟偏移）。
- 任意 block kind 都有 DOM 锚点 `hapi-message-${kind}:${id}`（user-text/agent-text/tool-call…），第一条未读不限 user-text。
- 消息窗口只往前翻（首屏最新 50 条），>50 条未读靠 load-until-found 翻页（须测）。
- 无 hub 端「按时间查 id」API，必须客户端边加载边扫。

**文件范围**：`web/src/components/AssistantChat/HappyThread.tsx`（+ `locateFirstUnreadMessage` + props + effect）、`web/src/components/SessionChat.tsx`（+ `firstUnreadTargetIdRef` + 传 props + `lastSeenAt`）、`web/src/router.tsx`（+ `lastSeenAt` 透传 + `onLocateSettled` 推进水位 + visibility 门控 + `locateSettledFor`）、`web/src/lib/sessionLastSeen.ts`（复用 L0.2 hook）。**不需新 hub API**。

**Done 条件**：
- 单测：定位到第一条未读；**未读 >50 条窗口外**（load-until-found 翻页定位）；无未读滚到底；settling 结束后才触发定位。
- 水位时序单测：定位完成前 markSessionSeen 不推进、完成后推进；hidden→visible 重新定位。
- `bun run typecheck:web && bun run test:web` 通过。

**验证命令**：`bun run typecheck:web && bun run test:web`。

**人工步骤**：多工具轮/并发（连发多条）验证定位最早未读；AFK 返回（锁屏/切走）验证水位冻结 + 定位正确；>50 条未读验证翻页定位。

---

## L3.2 · 环节3 · 浮窗联动定位

**目标**：点浮窗跳转后，联动滚到第一条未读（不只换会话）。

**方案**：浮窗（L1.3）跳转 `/sessions/$id` 后触发 L3.1 定位机制。

**前置依赖**：L1.3（浮窗）+ L3.1（定位）。

**硬约束/陷阱**：复用 L3.1 机制，勿另造。

**文件范围**：`web/src/components/PendingInboxFab.tsx`、`web/src/components/AssistantChat/HappyThread.tsx`。

**Done 条件**：单测：浮窗跳转后定位到未读。`typecheck:web` 通过。

**验证命令**：`bun run typecheck:web && bun run test:web`。

**人工步骤**：点浮窗 → 跳转 + 定位未读。

---

## L3.3 · 环节1 · 通知 deep link

**目标**：钉钉通知带 session id，点击直达 `/sessions/$id`。

**方案**：钉钉用 **markdown payload**（L2.1 已定），content 含 `[项目名·状态](webBaseUrl/sessions/$id)` 链接——点击直达会话（路由 `/sessions/$id` 已存在）。`webBaseUrl` 从 hub 配置取。

**前置依赖**：L2.1（钉钉，markdown payload）。

**硬约束/陷阱**：钉钉 markdown 链接语法 `[text](url)`；**text 消息不支持可点链接**（故 L2.1 用 markdown）；web 路由已存在无需改；`webBaseUrl` 须可配。

**文件范围**：`hub/src/dingtalk/`（文案加链接）；`serverSettings.ts`/`configuration.ts` 加 `webBaseUrl` 字段（若已有则复用）。

**Done 条件**：markdown content 含指向 `/sessions/$id` 的链接；单测链接格式 + webBaseUrl 注入。`bun run typecheck:hub` 通过。

**验证命令**：`bun run typecheck:hub && bun run test:hub`。

**人工步骤**：真实钉钉点击跳转验证（含远程）。

---

# 明确不做（附理由）

1. **停滞/卡住检测**：「`thinking=true` 且 N 分钟无新消息」近似识别卡住——会把「正常等子 agent」误判成停滞（等子 agent 时也长时间无新消息），违背「不误判」。hapi 现有设计（`thinking=true` 一律不打扰）已规避。
2. **`-p` 模式重构**：用 `claude -p --output-format stream-json --resume`（每轮一进程）让结束判断更明确——代价大（失常驻低延迟、要重做审批），且 `result` 事件有已知 bug（claude-code #1920），不解决根本。

---

# 待实测项

- **修复A · GLM 运行时语义**（L0.1）：✅ **已实测**（2026-07，`claude -p stream-json` 连 GLM）：result 带真实 usage（单轮 13411/3/14784、多工具轮 41402/101/18304）+ `modelUsage.contextWindow=1000000` + key `glm-5.2[1m]` 命中 `resolvedContextWindowKey`；流式 assistant usage `{0,0}` 占位（根因印证）。**剩**：result.usage 累计性（多轮量级像 last-call、ctx ~6% 合理），落地后看 ctx 是否偏高再定——不阻断。

---

# 验证 & 工作流（实现阶段通用）

- **自动化**：`bun run typecheck`（各包）+ `bun run test`；为新行为补用例。
- **手动**（dev web `:5173` 代理 hub `:3006`）：每项「人工步骤」。
- **流程**：改 → dev 验证 → `bun run build:single-exe` 出二进制 → 备份后替换 → 重启 hub（短暂中断会话）→ **先验证再 push**。
- **上游同步**：`git fetch upstream` → main 合 upstream/main → feat 分支合 main；冲突基本只在 `HappyThread.tsx` / `SessionList.tsx`。
- **行号漂移**：每项实现前对引用行号重新走查。
