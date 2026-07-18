# 外部通知渠道按页面可见性抑制 — spec（钉钉 / ServerChan / Telegram）

> fork: `veniai/hapi` · 工作目录 `/home/claw/projects/hapi` · 基线 `work/current`（2026-07）
> 状态：**已实现并上线**（commits e4582c5 + 11bdef1，deploy 2026-07-18）。本文件保留作设计记录。
> 触发场景：用户正盯着 web 页面看时，钉钉 / ServerChan / Telegram 机器人仍推送「空闲 / 待审批 / 完成」——冗余、吵。
> **范围**：三个外部渠道一起修——`DingtalkChannel`、`ServerChanChannel`、`HappyBot`(Telegram)。`PushNotificationChannel` 已做(参考实现)。文件名沿用「dingtalk」(原始触发场景),内容覆盖三渠道。
> **前置依赖**：本 spec 抑制 permission/input 的安全性依赖 [`pending-inbox-thinking-mask.md`](pending-inbox-thinking-mask.md)（红点修 thinking 遮蔽）。两者是同一注意力模型的两半，**须一起落地**（见 §5、§8）。

---

## 0. TL;DR

- **问题**：钉钉 / ServerChan / Telegram 三个外部渠道都不感知用户是否在看页面，盲发(push 已做)。
- **根因**：三者构造里无可见性概念；hub 已有 `VisibilityTracker` 按 namespace 追踪 web 可见性，`PushNotificationChannel` 已用它跳过 push——这三个只是没接进去。
- **修复**：给三个 channel 各自注入 `VisibilityTracker`，每个 `send*` 开头加 guard：该 namespace 有可见 web 连接就 `return`。照抄 push 写法。
- **范围**：三个 channel(构造注入 + send* guard)+ `startHub` 三处装配点传 tracker + 各自测试。不碰 web 上报链路、tracker、push、DB。
- **耦合（重要）**：可见性是 **namespace 级**（「有 tab 可见」≠「在看这个 session」）。抑制 permission/input 后，跨 session 的 AskUserQuestion 只能靠**红点**兜底，而红点当前被 `thinking` 遮蔽——故须先/同时落地 pending-inbox spec。ready/task 这类 fyi 无此依赖。

---

## 1. 背景 / 痛点

钉钉是 HAPI「人不在电脑前」的兜底通知渠道（见 `customizations.md` L2.1）。当前不判断用户是否已在线上看：正盯着会话 → agent 报「空闲 / 待审批」→ 钉钉照样叮。状态变化 web UI 本就实时显示（SSE + 红点 + 浮窗），这一下纯重复打扰。push（VAPID）渠道**已解决**同样问题（可见时跳过），钉钉是独立 channel，漏在外面。

---

## 2. 统一注意力模型（钉钉与红点是两半）

agent 需要用户时（permission / input / ready / 完成），信号有两条出口，按「用户在看不在」分流：

|  | 用户在看页面 | 用户没看 |
|---|---|---|
| **页内**（inline 提示 / 红点浮窗 / push toast） | 主力 | 无用 |
| **外部**（钉钉 / push 通知） | 冗余，**该静音** | 主力 |

- **pending-inbox spec** = 修「页内」侧：保证红点在 `thinking=true` 时也显示 permission/input（AskUserQuestion）。
- **本 spec** = 修「外部」侧：用户在看页面时钉钉静音。

两半合起来才自洽：**在看 → 页内红点/inline 兜着，外部静音；没看 → 外部钉钉兜着。** 故两者须协调，但**各自独立实现、不合并文件**（层不同；pending-inbox §9 亦明示不动钉钉）。

---

## 3. 现状走查（核查基准 `work/current`，2026-07，亲验）

| 设施 | 位置 | 现状 |
|---|---|---|
| 可见性追踪 | `hub/src/visibility/visibilityTracker.ts` | **namespace 级**。`hasVisibleConnection(namespace): boolean`、`isVisibleConnection(subscriptionId)`。无 per-session 焦点查询。**无需改。** |
| web 上报 | `web/src/hooks/useVisibilityReporter.ts` | 监听 `visibilitychange`，SSE 上报 `visible`/`hidden`。**无需改。** |
| push 参考 | `hub/src/push/pushNotificationChannel.ts:39 / :77 / :119` | `if (hasVisibleConnection(session.namespace)) { 改发 toast; return }`。**抄 guard，去 toast 分支。** |
| push 页内 toast | `sseManager.sendToast(namespace,…)` | 直发 SSE，**不经 `classifySessionAttention`，不被 thinking 遮**。push+钉钉同开时，可见时 push 的 toast 会兜底跨 session。 |
| 钉钉 channel | `hub/src/dingtalk/channel.ts` | 构造 `(webhook, secret?, keyword?, publicUrl?)`，四个 `send*`（含 `sendSessionCompletion`）**裸发**。**要改。** |
| ServerChan channel | `hub/src/serverchan/channel.ts` | 构造 `(sendKey, publicUrl)`，四个 `send*`（含 `sendSessionCompletion`）**裸发**。**要改。** |
| Telegram bot | `hub/src/telegram/bot.ts` | `HappyBot` 构造接收 `HappyBotConfig` 对象；三个 `send*`（无 `sendSessionCompletion`）**裸发**。**要改。** |
| channel 装配 | `hub/src/startHub.ts:174 / :201 / :206-216 / :225-232` | `visibilityTracker` 174 实例化、201 注入 push；206 构造 ServerChan、210 构造 Dingtalk、225 构造 `HappyBot` —— **三处均未传 tracker**。**要改三处。** |
| hub 有无 per-session 焦点 | — | **无**。`getCurrentSession` 等 grep 命中均指 Cursor 迁移 / 活跃会话，非「用户当前打开哪个 session」。钉钉只能做 namespace 级决策。 |
| session 取 namespace | `Session.namespace` | push 直用 `session.namespace`，钉钉同样可用。 |
| `NotificationChannel` 接口 | `hub/src/notifications/notificationTypes.ts` | 不变——可见性是 channel 内部细节，对 `NotificationHub` 透明。 |

> 钉钉发通知在 channel 的 `send*` 里，permission 还有 500ms debounce（`notificationHub.ts:131`）。guard 在 send 时判可见性——**总是读最新状态**：debounce 期间用户切回页面，发时判为可见即静音。语义正确。

---

## 4. namespace 级可见性 ≠ 在看这个 session（核心约束）

`hasVisibleConnection(namespace)` 只回答「该用户有没有任意一个可见 web tab」，**回答不了「在看 session A 还是 B」**。后果：

- **同 session**：看 A，A 抬权限 → inline 提示就在眼前 → 抑制钉钉 ✅ 正确。
- **跨 session**：看 A，**B** 抬 AskUserQuestion → tab 可见（namespace）→ 钉钉被抑制。此时 B 的请求靠谁兜底？
  - B 的 inline 提示：看不到（你在 A）✗
  - **红点**：当前被 `thinking` 遮蔽（`sessionAttention.ts:13`，未修）✗
  - push toast：仅 push 启用时 ✓；DingTalk-only 用户 ✗
  → **DingTalk-only 用户会彻底漏掉 B 的请求**，直到碰巧切到 B。

这是本 spec 的关键风险点，由 §5 的前置依赖化解。

---

## 5. 与 pending-inbox spec 的耦合（硬依赖，亲验）

抑制 permission/input 后，跨 session 的 AskUserQuestion 唯一可靠的页内兜底是**红点**。红点要可靠显示 permission/input，必须先修 `thinking` 遮蔽——即 [`pending-inbox-thinking-mask.md`](pending-inbox-thinking-mask.md)。

亲验现状（`web/src/lib/sessionAttention.ts:13`）：

```ts
if (options.selected || summary.thinking || summary.metadata?.lifecycleState === 'archived') {
    return null   // ← thinking=true 直接吞，pending 判定走不到。病灶未修。
}
```

故：

- **permission/input 的可见性抑制，安全性依赖 pending-inbox spec 已落地。** 两者须一起上（或 B 先）。
- ready / task-completion / session-completion 属 fyi，漏一下无伤，**无此依赖**——即便 B 没上，抑制它们也安全。
- 若用户**同时启用 push**：可见时 push 的 toast（不经分类器、不被 thinking 遮）会兜底跨 session，此时 B 非硬需求。但保守起见统一要求 B，不假设 push 一定开。

---

## 6. 语义定义：「在用页面」

- **判定**：该 session 所属 namespace 下存在至少一个上报为 `visible` 的 web SSE 连接。
- **`visible` 含义**（web 端）：`document.visibilityState === 'visible'`。
- **能抑制**：切别的 app / tab、最小化、锁屏（多数浏览器翻 hidden）、手机锁屏。
- **不能抑制（已知缺口）**：离开座位、tab 还在前台开着——`visibilityState` 仍 visible。与 push 同源同限制；留待将来加 web idle hook（监听输入事件，空闲 N 分钟本地降级上报 hidden），**hub 不用动**。
- **可见性竞争（已接受，Codex review）**：通知只在事件触发那一刻判可见性，**不重试**。请求在「可见」时被抑制后，用户随后藏 tab 不会补发——靠红点兜底（permission 回来看见，agent 阻塞等答；完成类 fyi 无害）。这是「在看就不发」的同源代价，非 bug，不修。

---

## 7. 改动

### 7.1 共同 guard 模式（三个 channel 一致）

每个 channel：
1. 构造注入 `visibilityTracker?: VisibilityTracker`（可选，兼容旧测试）。
2. 每个 `send*` 在 `if (!session.active) return` 之后（无 active 守卫的 `sendSessionCompletion` 放最前）加：

```ts
if (this.visibilityTracker?.hasVisibleConnection(session.namespace)) return
```

照抄 `pushNotificationChannel.ts:39 / :77 / :119`，去掉「改发 toast」分支（这三者无自有页内通道；可见时由红点 / inline / push toast 兜底，静默即可）。`this.visibilityTracker?.` 可选链——未注入时跳过 guard（保底发，不漏）。

### 7.2 各 channel 构造签名

| channel | 文件 | 构造改动 | send* 数 |
|---|---|---|---|
| DingtalkChannel | `hub/src/dingtalk/channel.ts` | 末尾加 `private readonly visibilityTracker?: VisibilityTracker` | 4（含 completion） |
| ServerChanChannel | `hub/src/serverchan/channel.ts` | 末尾加 `private readonly visibilityTracker?: VisibilityTracker` | 4（含 completion） |
| HappyBot (Telegram) | `hub/src/telegram/bot.ts` | `HappyBotConfig` 加 `visibilityTracker?: VisibilityTracker`；构造里赋给新增 private 字段 `this.visibilityTracker` | 3（无 completion） |

### 7.3 `hub/src/startHub.ts`（三处装配点）

把已在作用域内的 `visibilityTracker`（:174 实例化）追加传给三个 channel：

- ServerChan（约 :206）：`new ServerChanChannel(sendKey, publicUrl, visibilityTracker)`
- Dingtalk（约 :210）：`new DingtalkChannel(webhook, secret, keyword, publicUrl, visibilityTracker)`
- Telegram（约 :225）：`new HappyBot({ syncEngine, botToken, publicUrl, store, visibilityTracker })`

### 7.4 测试

照 `pushNotificationChannel.test.ts` 的 mock（`{ hasVisibleConnection: () => true/false } as never`），三个 channel 各补：
- 可见 → 不发（无 fetch / 无 bot 发送）。
- 不可见 → 正常发（断言 payload）。

现有 `dingtalk/channel.test.ts` 的 `makeChannel` 不传 tracker（`undefined` → 可选链跳过 guard → 照发），旧用例不破坏；可见/不可见用例单独构造带 mock 的 channel。ServerChan / Telegram 测试同理。

---

## 8. 实现顺序（依赖驱动）

1. **先 pending-inbox spec**：`web/src/lib/sessionAttention.ts` 重排条件（pending 判定提到 thinking 短路之前）+ 补 4 条单测。解掉红点 thinking 遮蔽。
2. **再本 spec**：三个 channel（钉钉 / ServerChan / Telegram）各注入 tracker + send* guard + `startHub` 三处装配 + 三个测试。

两步可同 PR。**切勿只上本 spec 不上 pending-inbox**——否则仅外部渠道（关 push）的用户跨 session AskUserQuestion 会被吞（§4）。

---

## 9. 验收

- [ ] `bun typecheck` 全绿。
- [ ] `bun run test` 全绿：含 `sessionAttention.test.ts`（pending-inbox）8 旧 + 4 新，及 `dingtalk` / `serverchan` / `telegram` 三个 channel 的可见/不可见用例。
- [ ] dev 实测（哪个渠道开了就验哪个，行为一致）：
  - 开 web 看 session A，A 触发 ready/permission/task → 外部渠道**不响**。
  - 切走 tab 再触发 → 响。
  - **跨 session**：看 A，B 弹 AskUserQuestion → 外部渠道不响，但**红点出现 B**（验 pending-inbox 生效）；点入 B 能答。
  - 仅外部渠道（关 push）重复上一条 → 红点仍兜底，不漏。

---

## 10. 不在本次范围

- web idle / 活跃心跳（覆盖「离开座位」）——见 §6 缺口，将来单独加，hub 不动。
- per-session 焦点追踪：**不做**。跨 session 已由红点（pending-inbox）兜底——这是设计选择，不是缺漏。hub 再学「可见 tab 在看哪个 session」属过度设计，明确否决。
- push channel 行为不变（已这么做）。
- 钉钉通知事件口径（`permission`/`input`/`error`/`completed`，无 unread，见 `customizations.md` L2.1）不变——只加可见性门控。
- 无 DB schema 变更、无迁移。
