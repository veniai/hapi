# 待处理浮窗被 thinking 掩盖 — AskUserQuestion 不进红点 spec

> fork: `veniai/hapi` · 工作目录 `/home/claw/projects/hapi` · 基线 `work/current`（2026-07）
> 状态：**已实现并上线**（commit e4582c5，deploy 2026-07-18）。本文件保留作设计记录。
> 触发场景：agent 用 AskUserQuestion（或任意权限请求）让用户做选择时，**待处理浮窗（红点）不显示该会话**——明明必须用户操作却被当成「正在思考」藏起来。

---

## 0. TL;DR

- **bug**：agent 卡住等用户回答（AskUserQuestion / 权限请求）时，会话的 `thinking` 仍是 `true`，浮窗分类器见 `thinking` 就短路返回「不打扰」，把这条**最该浮出**的请求踢出红点。
- **根因**：`thinking=true` 被当成「一律不打扰」的代理，但它混了三种状态——「正在干活」「等子 agent」（这俩确实别打扰）和「**卡住等你回答**」（这必须打扰）。第三种被误伤。
- **修复**：在 `classifySessionAttention`（`web/src/lib/sessionAttention.ts`）里把**显式请求**（permission / input）的判定**提到 `thinking` 短路之前**——pending 请求无视 thinking 浮出；`thinking` 只保留用来压制 `unread` / `background` 这种「动静类」attention。
- **范围很窄**：改一个函数（重排条件顺序）+ 补单测。不碰 CLI 的 thinking 生命周期、不碰 hub、不碰钉钉、不动 DB。现成 8 条单测**逐条比对全过**。

---

## 1. 背景 / 痛点

待处理浮窗（`PendingInboxFab`，`customizations.md` L1.3）的设计意图：聚合其它活跃会话里「需要用户行动」的状态——`permission` / `input` / `unread`——点一下跳过去逐个清。

用户报告：agent 用 **AskUserQuestion 让我做选择**的时候，那个会话**没出现在红点里**。这违背直觉——「让我选」正是最硬的「需要我操作」，理应永远浮出。

---

## 2. 现状走查（核查基准 `work/current`，2026-07）

| 环节 | 位置 | 现状 |
|---|---|---|
| AskUserQuestion 分类 | `shared/src/sessionSummary.ts:5-11` | 在 `INPUT_REQUEST_TOOLS` 里 → `classifyKind`（:28-30）归 `'input'`。**分类正确。** |
| 请求入 summary | `shared/src/sessionSummary.ts:145` | `toSessionSummary` **无条件**算 `pendingRequestKinds`，**即使 thinking=true 也带着**。**数据齐全。** |
| 浮窗白名单 | `web/src/components/PendingInboxFab.tsx:12` | `PENDING_KINDS = {'permission','input','unread'}`，`'input'` 在内。**白名单正确。** |
| 浮窗筛选 | `web/src/components/PendingInboxFab.tsx:19-30` | 先踢 `!active \|\| selected`，再 `classifySessionAttention`，命中白名单才进队。 |
| **分类器短路** | `web/src/lib/sessionAttention.ts:13` | `if (selected \|\| thinking \|\| archived) return null` —— **thinking=true 直接吞掉，连后面的 pending 判定都走不到。← 病灶** |
| 请求抬起不碰 thinking | `cli/src/modules/common/permission/BasePermissionHandler.ts:149` | 把请求写进 `agentState.requests`，**完全不动 thinking**。 |
| thinking 何时翻 false | `cli/src/claude/claudeRemote.ts:260` | `updateThinking(false)` **仅在 `message.type === 'result'` 时**触发；`:313` 循环结束再兜底一次。 |
| hub 落 thinking | `hub/src/sync/sessionCache.ts:222` | keepAlive 上报值即 session.thinking（CLI 每 2s 上报一次）。 |

> 数据链是通的：请求确实进了 `pendingRequestKinds`，浮窗白名单也收 `'input'`。**唯一的拦截点**是分类器那个 `thinking` 短路。

---

## 3. 根因：AskUserQuestion 等你回答时，thinking 凭什么是 true

Claude/GLM 路径里 CLI 侧 `thinking` 的翻转点（`cli/src/claude/claudeRemote.ts`）：

- `:224` / `:242` —— `updateThinking(true)`：循环开始 + 收到 `system/init`。
- `:260` —— `updateThinking(false)`：**仅**收到 `result` 消息。
- `:313` —— `updateThinking(false)`：整个 query 循环结束。

关键：**`result` 是整轮结束时才发的终结消息**。agent 调 AskUserQuestion（或任意需审批的工具）时，SDK 抬起权限请求并**暂停**等 `tool_result`——此刻**还没有 `result`**，所以 `thinking` 保持 `true`，直到用户答完、整轮跑完才翻 false。

而抬请求的 `BasePermissionHandler` 不碰 thinking（§2）。于是：

```
agent 调 AskUserQuestion → 请求进 agentState.requests（input）
                        → 但 CLI thinking 仍 true（没 result）
                        → keepAlive 每 2s 上报 thinking=true
                        → hub session.thinking=true
                        → classifySessionAttention 见 thinking → return null
                        → 浮窗过滤掉 → 红点不显示
```

ACP 路径同理：`cli/src/agent/runners/runAgentSession.ts:194` 设 `thinking=true`，`:211` 的 `finally` 才置 false——中间 `backend.prompt()` 阻塞着等用户回答，thinking 全程 true。

### 为什么「有时候」才不出现

`thinking` 是不是 true 取决于时机：主 agent 轮中抬问（thinking=true → 藏）、轮与轮之间（thinking 已 false → 露）、或来自子 agent（父会话 thinking=true → 藏）。所以表现间歇，但**最常见的主 agent 主动提问场景是稳定被藏**。

（次要放大项：`sessionCache.ts:316-341` 的 `markMessageQueued` 有 15s thinking 宽限期——用户发消息后即使 CLI 还没开始流式也保 thinking=true。这主要覆盖发消息→开始流式那段空隙，与本 bug 主因叠加，使 thinking=true 的窗口更长。本 spec 不动它。）

---

## 4. 贯穿原则（修正「thinking 一律不打扰」）

`customizations.md` 原则：「`thinking=true` 的会话（正在跑、含等子 agent）一律不打扰」。本 spec **细化**它——按 attention 的**来源**分流：

| attention 来源 | 含义 | thinking=true 时该不该浮出？ |
|---|---|---|
| `permission` / `input`（**显式请求**，含 AskUserQuestion） | agent 卡住**等用户** | **浮出** ✅（本 spec 修正） |
| `unread` / `background`（**动静类**） | 有新消息 / 后台任务在跑 | 不打扰 ❌（保持原意） |

一句话：**thinking 压制「动静」，不压制「请求」**。等子 agent 的会话没有 pendingRequestKinds，仍被 thinking 压住——原意不破。

---

## 5. 方案：重排 `classifySessionAttention` 条件顺序

`web/src/lib/sessionAttention.ts`，把 pending 请求判定**提到 thinking 短路之前**，`selected` / `archived` 仍最高优先：

```ts
export function classifySessionAttention(
    summary: SessionSummary,
    options: { selected: boolean; lastSeenAt: number }
): SessionAttention | null {
    // 选中（已在视线内）或已归档（死会话）—— 永不浮出，即便残留 stale 请求。
    if (options.selected || summary.metadata?.lifecycleState === 'archived') {
        return null
    }

    const pendingRequestKinds = Array.isArray(summary.pendingRequestKinds)
        ? summary.pendingRequestKinds
        : []

    // 显式的「需要用户操作」请求（permission / input，含 AskUserQuestion）——
    // 即使 thinking=true 也浮出：agent 此刻是卡住等你回答，不是在忙。
    if (pendingRequestKinds.includes('permission')) {
        return { kind: 'permission' }
    }
    if (pendingRequestKinds.includes('input')) {
        return { kind: 'input' }
    }

    // 无显式请求时，thinking 才压制「动静类」attention（unread / background）——
    // 保留「等子 agent / 正在干活不打扰」的原本意图。
    if (summary.thinking) {
        return null
    }

    if (summary.active && (summary.backgroundTaskCount ?? 0) > 0) {
        return { kind: 'background' }
    }

    if (summary.updatedAt > options.lastSeenAt) {
        return { kind: 'unread' }
    }

    return null
}
```

**唯一行为变化**：`thinking=true && 有 pending 请求` 的会话，从「null（不浮）」变成「浮出 permission/input」。其余全不变。

---

## 6. 爆炸半径（改共享分类器影响谁）

`classifySessionAttention` 两个消费者：

| 消费者 | 位置 | 传参 | 改后影响 |
|---|---|---|---|
| **待处理浮窗** | `PendingInboxFab.tsx:25` | `selected:false`（上游已踢选中） | **修好**——AskUserQuestion / 权限请求会进红点。本 spec 的目标。 |
| **会话列表详情态** | `SessionList.tsx:659`（仅 `showDetailedStatus`） | 真 `selected`（逐行） | 分类器会返回 attention，但 `SessionList.tsx:691` 详情态行 thinking 时先渲染转圈 spinner，attention 指示分支不可达——**实际未显示**（Codex review 核实）。主功能（红点）不受影响。 |

> 改共享分类器仍是正解——红点（`PendingInboxFab`）是真正的消费者。详情态不显示是 `SessionList.tsx:691` 的渲染顺序（thinking 先画转圈）所致，与分类器无关，不在本 spec 范围。

---

## 7. 改动清单

### 7.1 `web/src/lib/sessionAttention.ts`

按 §5 重排条件顺序（仅挪动 `if (summary.thinking)` 的位置 + 注释，无新增依赖）。

### 7.2 `web/src/lib/sessionAttention.test.ts`

**现有 8 条逐条比对，全过**（核对记录，免回归）：

| # | 测试（行） | 输入要点 | 期望 | 改后 |
|---|---|---|---|---|
| 1 | `:27` selected | `selected:true` + permission | null | ✅ step1 `selected` 拦 |
| 2 | `:35` archived | `archived` + active:false + permission | null | ✅ step1 `archived` 拦 |
| 3 | `:50` permission 优先 | permission + updatedAt 新 | `{permission}` | ✅ 无 thinking |
| 4 | `:63` legacy 无 kinds | 删 pendingRequestKinds | `{unread}` | ✅ |
| 5 | `:75` unread | updatedAt 新 | `{unread}` | ✅ |
| 6 | `:83` background | bg=2 | `{background}` | ✅ |
| 7 | `:91` inactive unread | active:false + updatedAt 新 | `{unread}` | ✅ |
| 8 | `:99` inactive unread>bg | active:false + bg=2 | `{unread}` | ✅ |

**新增用例**（核心 + 回归守护）：

```ts
it('surfaces input request even while thinking (AskUserQuestion)', () => {
    const attention = classifySessionAttention(
        makeSummary({ id: 'a', thinking: true, pendingRequestKinds: ['input'], pendingRequestsCount: 1 }),
        { selected: false, lastSeenAt: 0 }
    )
    expect(attention).toEqual({ kind: 'input' })
})

it('surfaces permission request even while thinking', () => {
    const attention = classifySessionAttention(
        makeSummary({ id: 'a', thinking: true, pendingRequestKinds: ['permission'], pendingRequestsCount: 1 }),
        { selected: false, lastSeenAt: 0 }
    )
    expect(attention).toEqual({ kind: 'permission' })
})

it('still suppresses unread/background for thinking sessions without pending requests', () => {
    // 等子 agent / 正在干活 —— 无显式请求，thinking 仍压制动静
    const attention = classifySessionAttention(
        makeSummary({ id: 'a', thinking: true, backgroundTaskCount: 2, updatedAt: 5000 }),
        { selected: false, lastSeenAt: 0 }
    )
    expect(attention).toBeNull()
})

it('selected still wins over a thinking pending request', () => {
    const attention = classifySessionAttention(
        makeSummary({ id: 'a', thinking: true, pendingRequestKinds: ['input'] }),
        { selected: true, lastSeenAt: 0 }
    )
    expect(attention).toBeNull()
})
```

---

## 8. 验证

### 8.1 机械（`work/current` 本地，无副作用）

```bash
bun typecheck && bun run test
```

重点：`web/src/lib/sessionAttention.test.ts` 8 旧 + 4 新全绿。

### 8.2 手测（dev，web `:5173` 代理 hub `:3006`）

| 路径 | 期望 |
|---|---|
| 在会话 A，会话 B 的 agent 调 AskUserQuestion | **红点出现**，点入 B 能答（修复前：不出现） |
| 在会话 A，会话 B 的 agent 要权限（Bash/Edit） | **红点出现** |
| 正在流式干活的会话（thinking、无请求） | 不进红点（等子 agent 同理）✅ 不回归 |
| 当前打开的会话自身有请求 | 不进红点（已在视线内）✅ |
| 详情态列表里，thinking 且有请求的会话 | 显示 attention 指示（顺带修好）|

---

## 9. 不在本次范围

- **不动 CLI 的 thinking 生命周期**（`claudeRemote.ts` / `runAgentSession.ts` 的 `updateThinking` 触发点）。`thinking=true` 在「卡住等回答」期间为 true 本身没错（轮确实没结束）；错的是分类器拿它当「别打扰」代理。修分类器即可。
- **不动 hub**（`sessionCache.ts` 的 thinking 落值、15s 宽限期、keepAlive）。
- **钉钉是下游依赖方**（`dingtalk-visibility-suppression.md` 是 hub 侧按页面可见性抑制外部通知的通道；它**依赖本 spec**——可见时钉钉/ServerChan/Telegram 静音后，跨 session 的 permission/input 全靠本 spec 修好的红点兜底，两者须一起落地）。本 spec 不动钉钉代码，只动 web 分类器。
- **不动浮窗白名单**（`PENDING_KINDS`）、不动浮窗上游 `!active / selected` 筛选。
- **不引入**「thinking 会话的 pending 请求也要降级显示」之类新 UX——浮出即按原 permission/input 语义。
- 已知小尾巴（不阻塞）：非归档但 `active:false` 的会话若残留 stale 请求，详情态会显示 permission/input。这与「inactive 会话仍可显示 unread」（现有测试 `:91`/`:99`）同源同设计，浮窗上游已用 `!active` 踢掉，不构成噪音。如需收紧，后续单独评估给 pending-override 加 `active` 门控。
