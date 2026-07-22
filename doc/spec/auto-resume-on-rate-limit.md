# Claude 会话断流 / 限额自动恢复（auto-resume）

> fork: `veniai/hapi` · 工作目录 `/home/claw/projects/hapi` · 基线 `work/current`（2026-07）
> 状态：**方案 v2（复用定时发送 + hub 侧机械检测），代码尚未改动**。本文件仅描述方案，未实现。
> 触发场景：GLM 网关（`ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic`，glm-5.2）下，Claude remote 会话撞 5 小时使用限额 `[1308]`，turn 终态失败 → 会话进 idle 卡死，要人去点"继续"。诉求：HAPI 自动续上。

---

## 0. TL;DR

- **痛点**：GLM 网关下 Claude remote 会话撞 5h 限额 `[1308]`（`已达到 5 小时的使用上限…将在 YYYY-MM-DD HH:MM:SS 重置`），turn 终态失败 → 会话 idle 卡死。HAPI 核心场景是远程控制，人不在前 = 体验断裂，诉求自动续。
- **信号在哪（实测铁证）**：错误以 **`model:"<synthetic>"` 的 assistant 消息**进 hub 并落库——**不是** `result` 消息（converter 对 `result` 返回 null，result 不落库，见 §2.1）。text block 即 `API Error: Request rejected (429) · [1308]…将在 <时间> 重置…`。**sentinel `model:"<synthetic>"`** 把 harness 注入的错误与 agent 手打讨论（`model:"glm-5.2"`）死死分开。
- **检测（hub，机械，零 LLM）**：`sessionHandlers.ts` 收消息入库后，对 `model:"<synthetic>" && role:"assistant"` 的消息跑一条 regex 取 `[code] + 重置时间`。
- **动作（复用定时发送）**：`syncEngine.sendMessage(sid, {text: 恢复提示, scheduledAt: 重置时间, localId, sentFrom:'system'})`（配置点 `startHub.ts:177`）→ 存一条 `scheduled_at` 未来的消息行 → 现成 5s tick `releaseMatureScheduledMessages` 到点 emit `new-message` → runner 喂 agent → 下 turn 消费。`localId` 必填（`addMessage` guard `messages.ts:51`）。
- **两种终态错误都续**：quota `[1308]`（有 reset 时间，排到重置点）+ rate `[1302]`（无 reset，退避重试，§6.5）。`[1302]` 原砍（赌 SDK 10x retry 吃掉），实测 SDK 撑 ~3min（退避 3s→38s）仍耗尽 → 终态落库 → 现补退避兜底（治本无解：限流可持续 ~16min >> SDK retry 总时长）。
- **范围**：新增 `hub/src/sync/autoResume.ts`（纯函数 + prompt 常量）+ 测试；改 `sessionHandlers.ts`（hook+try/catch + dep 回调）+ `server.ts`（透传）+ `startHub.ts:177`（配置点 → `syncEngine.sendMessage`）+ `{syncEngine,messageService}.ts`（`sentFrom` 联合加 `'system'`）。**不碰 cli、不改 DB schema（`scheduled_at` 早在）、不动 shared 类型、不碰 web 渲染、不碰 Cursor/Codex**。

---

## v1 → v2：翻的两个判断

v1（CLI 进程内 `setTimeout` + `session.queue.unshift`，见 git history）两大判断被翻，理由如下：

1. **持久化从「§11 未来工作」拉进 scope**。v1 §9.1 自列头号局限：「timer 进程内、不持久化；runner/hub 重启即丢」。v2 复用现成的 scheduled-send 管道（消息行落 hub DB、5s tick 到点 emit），持久化白得，该局限消失。v1 §11 自己也写过「调度可放 hub」——v2 顺此走完。
2. **检测从「留 CLI」（v1 §4 红线）改为「放 hub」**。v1 §4 以 hub-dumb 红线为由拒绝 hub 侧调度。**v2 翻**：检测是 `<synthetic>` sentinel + 一条 regex 的机械触发——不碰 LLM、不涉 agent 推理，与 hub 已有的「`scheduled_at<=now` → emit」5s tick 同类机械规则，红线精神（不碰 LLM、推理放 agent 侧）不违。且复用 scheduled-send 本就要消息行在 hub DB，检测天然在 hub 侧最省零件。

代码层面 v1 整套（launcher 闭包态 / setTimeout / queue.unshift / 手动接管取消 / finally 清理 / transient 退避计数）**全弃**，git history 可查。

---

## 1. 背景 / 痛点

用户跑 GLM 网关，Claude Code 会话撞 5 小时限额：

> `API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-07-17 16:01:19 重置。]`

turn 终态失败、会话进 idle。用户不在电脑前（HAPI 核心场景就是远程控制）就得手动点"继续"，体验断裂。诉求：**HAPI 检测到这类终态失败时，自动在限额重置时刻续上一段 continue 提示词**。

参考实现：`~/cc-monitor`（bash + tmux + Claude 原生 hook）已验证 GLM 包月 5h 限额的自动恢复；HAPI 把"抓屏取时间"换成"读已落库的 `<synthetic>` 消息文本"、"tmux 注入"换成"复用 scheduled-send"、"cron watchdog"换成"hub 5s tick"。

---

## 2. 现状走查（核查基准 `work/current`，2026-07，亲验 + 真实 log/DB 数据）

### 2.1 SDK retry / `<synthetic>` 消息机制（实测铁证）

| 环节 | 证据 | 现状 |
|---|---|---|
| SDK 内部 retry | `~/.hapi/logs/2026-07-18-20-29-53-pid-3112834.log:550-640` | 发 `system/api_retry`：`{subtype:"api_retry", attempt, max_retries:10, retry_delay_ms, error_status:429, error:"rate_limit"}`，指数退避。瞬时 `[1302]` 多被此处吃掉。 |
| retry 耗尽 | `~/.hapi/logs/2026-07-17-08-11-54-pid-1706459.log:2711498-2711508` | 终态 `result{type:"result", subtype:"success", is_error:true, api_error_status:429, duration_api_ms:3891936, result:"API Error…[1308]…重置…"}`。**`duration_api_ms`≈65 分钟**——SDK 对限额错误空转 retry 到耗尽。 |
| **`result` 不落 hub 库**（v2 新查证） | `claudeRemoteLauncher.ts:255-263` + `sdkToLogConverter.ts:356` `case 'result'` | launcher 的 result 块**只** enqueue 一条 usage 载体；`sdkToLogConverter.convert(result)` **返回 null**（:257 注明）。→ 终态 `result` 消息**不进 hub DB**。 |
| **错误文本走 `<synthetic>` assistant 消息**（v2 新查证，铁证） | `~/.hapi/hapi.db` 多条历史样本 | 错误以 `{role:"agent", content:{type:"output", data:{message:{type:"message", role:"assistant", model:"<synthetic>", content:[{type:"text", text:"API Error: Request rejected (429) · [1308]…将在 <时间> 重置…"}]}}}}` **落库**。实测 2026-07-19/20 三条真样本 reset 时间：`16:02:10` / `21:20:31` / `21:05:45`，regex 全 hit（§5）。负样本：同库 agent 手打讨论 1308 的消息 `model:"glm-5.2"`（非 `<synthetic>`）——证明 sentinel 门控必要且有效。 |

**subtype 陷阱**（v1 已踩）：错误时 `subtype` 仍是 `"success"`。**v2 绕开**——不依赖 `result`/`subtype`，改靠 `<synthetic>` sentinel + 文本 regex。

### 2.2 HAPI 现有零件（v2 用这套）

| 能力 | 位置 | 现状 / v2 用法 |
|---|---|---|
| **定时发送（复用核心）** | `messageService.sendMessage({scheduledAt})`（`messageService.ts:480`）+ `syncEngine` 5s tick `releaseMatureScheduledMessages`（`syncEngine.ts:167` piggyback `expireInactive`） | web 已用：带未来 `scheduled_at` 的消息行，到点查 `scheduled_at<=now AND invoked_at IS NULL` → emit `new-message` 给 `session:X` room。**正好是 auto-resume 要的「到点续」**。 |
| scheduled 行存活 | `sessionHandlers.ts:363-374` | session end 时**只** force-invoke 即时 queued，**不**碰 scheduled 行（注释：「fire when mature, regardless of session end」）。→ 持久、runner 重连/重启照发。 |
| **hub 消息入库点（v2 挂载点）** | `sessionHandlers.ts:89` `socket.on('message')` → `:119` `store.messages.addMessage(sid, content, localId)` | 现做 activity / attention（`:125` `isAgentResultContent`）/ todo / team 提取。← v2 在 addMessage 后加 quota 检测 hook。 |
| `<synthetic>` sentinel | SDK 注入、已落库（§2.1） | 现无人用。← v2 的门控。 |
| dep 回调透传先例 | `server.ts:46`（deps 类型，`onAttentionBump` 等）+ `:130`（透传） | v2 加 `onAutoResumeSchedule` 同模式透传到配置点。 |
| 重注入 API（v1 用，v2 弃） | `cli/src/utils/MessageQueue2.ts:unshift` | v2 不再用——恢复消息走 hub scheduled-send → runner 正常消费路径，不经 CLI queue.unshift。 |

### 2.3 恢复消息怎么被捡起

scheduled 行到点 → `releaseMatureScheduledMessages` emit `new-message` 到 `session:X` → runner（常驻 CLI daemon，`cli/src/index.ts runner`，systemd active）ack `messages-consumed` → 消息进 agent 输入 → 下 turn 以恢复提示为输入。**与用户手发的定时消息完全同路径**，零特殊接线。mode 用 session 当前态（与普通用户消息一致）。

> runner 接收而非交互式 CLI——故 `session.active=0` 照样触发（见 memory `scheduled-send-works-via-runner`）。唯一发不出的情形：到点时 hub/runner 都挂。

---

## 3. 根因

GLM 限额让 turn 终态失败，hub **落了那条 `<synthetic>` 错误消息但没人读它**，也没排程任何恢复 → 会话 idle 等人手点"继续"。而恢复所需的全部信息（错误信号 sentinel、reset 时间）**都在那条已落库的消息里**，只差一个 regex + 一条 scheduled 行。

> 注：`duration_api_ms:3891936`（65 分钟）说明 SDK 对 `[1308]` 这类不可恢复限额错误会空转 retry 到耗尽。v2 接受这个开销（在终态 `<synthetic>` 后接管）；更早 abort 见 §11。

---

## 4. 排除的路径 / 翻案

| 路径 | 结论 |
|---|---|
| **v1 进程内 `setTimeout` + `queue.unshift`** | ❌ timer 进程内、重启即丢（v1 §9.1 头号局限）。v2 复用 scheduled-send 取代。 |
| **v1 检测留 CLI（v1 §4 红线）** | ❌ **翻案**（见「v1→v2」）：检测是 sentinel + regex 机械触发，不碰 LLM；且复用 scheduled-send 本就要消息行在 hub DB。 |
| Anthropic `rate_limit_event` 的 `resetsAt` | ❌ GLM 429 不发这事件（那是 Anthropic 自家限额）。 |
| `subtype` 判失败 | ❌ 错误时仍是 `"success"`。v2 绕开。 |
| cc-monitor 抓终端屏幕取 reset 时间 | ❌ HAPI 用 SDK，无 pane。reset 时间已在落库文本里。 |
| 外部 cron watchdog | ❌ hub 5s tick 即是，多余。 |
| 重发原始用户消息 | ✗ Claude 有完整上下文历史，重发原消息可能重做已部分完成的步骤。v2 用 continue 提示词。 |

---

## 5. 抓手：`<synthetic>` 消息 text block 里就有 reset 时间

落库的 `<synthetic>` assistant 消息（实测原文，`message.content[0].text`）：

```
API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-07-17 16:01:19 重置。][20260717143...
```

**性质**：
1. harness/GLM **注入的固定文本**（错误码 `[1308]` + 中文模板 + `将在 <时间> 重置`），非模型随机生成 → 稳定可匹配。
2. 在**已落库的 `<synthetic>` 消息**里 → hub 入库时即可见。
3. reset 时间格式固定 `YYYY-MM-DD HH:MM:SS`（空格分隔、无时区 → 本地时间，与 GLM 服务器本地时间一致）。

**门控**：`data.message.model === "<synthetic>" && data.message.role === "assistant"`。这俩把 harness 注入错误与 agent 手打讨论（`model:"glm-5.2"` 等真模型名）死死分开——实测同库 agent 讨论错误的负样本 `model:"glm-5.2"`，门控正确排除。

**正则（quota）**：`/\[(\d+)\][^\]]*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*重置/`
- `\[(\d+)\]` 捕获错误码（首个 `[纯数字]`，即 `[1308]`；`(429)` 是括号不算）。
- `[^\]]*?` 跨过 `已达到…将在 `（含 `[` 但不含 `]`，到末尾 `]` 前停）。
- 捕获 `2026-07-17 16:01:19` + `\s*重置`。
- 时间按**本地时区**解析：`new Date(y, m-1, d, h, mi, s).getTime()`（不用 `Date.parse` 空格串——手解更稳、跨引擎无歧义）。

实测三条真样本（16:02:10 / 21:20:31 / 21:05:45）regex 全 hit、reset 时间本地时区解析正确。

---

## 6. 方案

### 6.1 新 helper `hub/src/sync/autoResume.ts`（**新建**）

纯函数 + 常量，可单测，对标 `rateLimitParser.ts` 模式。

```ts
const QUOTA_RESET_PATTERN = /\[(\d+)\][^\]]*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*重置/;

/**
 * 从 hub 入库的 agent 消息中识别 GLM 限额终态错误。
 * content 形如 {role:"agent", content:{type:"output", data:{message:{...}}}}。
 * 只认 model:"<synthetic>" + role:"assistant" 的 harness 注入消息（agent 手打讨论带真模型名，被排除）。
 * 命中 quota → {code, resetsAtMs}；否则 null（不自动恢复）。
 */
export function classifySyntheticQuotaError(content: unknown): {
    code: string;
    resetsAtMs: number;
} | null {
    const sdk = (content as any)?.content?.data?.message;
    if (!sdk || sdk.model !== '<synthetic>' || sdk.role !== 'assistant') return null;

    // 拼接 text block
    const blocks: unknown[] = Array.isArray(sdk.content) ? sdk.content : [];
    const text = blocks
        .map((b: any) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
        .join('');
    if (!text) return null;

    const m = text.match(QUOTA_RESET_PATTERN);
    if (!m) return null; // transient([1302]/529/无 reset 时间) 或未知 → 不处理
    const p = m[2].match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/)!;
    const resetsAtMs = new Date(+p[1], +p[2] - 1, +p[3], +p[4], +p[5], +p[6]).getTime();
    return { code: m[1], resetsAtMs };
}

/** 复用 cc-monitor 验证过的 recovery 文案；前缀自标「系统自动恢复」。
 *  sentFrom:'system'（已加进联合，§6.3）让 web 日后能徽章；现靠文案自标即可识别。 */
export const QUOTA_RESUME_PROMPT =
    '（系统自动恢复：API 5 小时限额已重置）临时中断，继续刚才的任务：' +
    '单步过长可拆分但不跳过；已完成不重做。';
```

> `content.content.data.message` 导航若与现有 unwrap helper（`sessionActivity.ts` 等）重叠则复用；否则按上安全导航。

### 6.2 `sessionHandlers.ts` hook（`socket.on('message')`，:89）

`addMessage`（:119）后加：

```ts
try {
    const quota = classifySyntheticQuotaError(content);
    if (quota) onAutoResumeSchedule?.(sid, quota.resetsAtMs, quota.code);
} catch (e) {
    logger.warn(`[auto-resume] classify failed for ${sid}: ${e}`); // malformed 消息永不炸主入库流程
}
```

`SessionHandlersDeps`（:87）加可选回调：

```ts
onAutoResumeSchedule?: (sessionId: string, resetsAtMs: number, code: string) => void;
```

解构出来（与 `onAttentionBump` 等同层）。注意：hook 在 addMessage **之后**、与 `isAgentResultContent` 检查（:125）同级；不阻断现有 activity/attention/todo/team 流程。helper 是安全导航本不抛，外层 `try/catch` 兜底防 malformed 消息炸主入库。

### 6.3 透传链 + 配置点（同 `onAttentionBump` 路径）

透传三处各加 `onAutoResumeSchedule?` 字段：`server.ts` `SocketServerDeps`（:46 类型）+ 透传（:130）→ `sessionHandlers.ts` `SessionHandlersDeps`（:65 类型 / :87 消费）。照抄 `onAttentionBump` 走法。

配置点 **`startHub.ts:177`**（`createSocketServer({...})`），与 `onAttentionBump`（:194 `(sessionId) => syncEngine?.bumpAttention(sessionId)`）同处——`syncEngine` 在闭包里，调公开的 `syncEngine.sendMessage`（:558）即可：

```ts
onAutoResumeSchedule: (sid, resetsAtMs, _code) => {
    // scheduledAt 在过去 → sendMessage 当即时消息发（messageService:530 isFutureScheduled 判定），
    // 即「SDK 空转已超过 reset 点」时立刻续；在未来 → 5s tick 到点发。
    void syncEngine?.sendMessage(sid, {
        text: QUOTA_RESUME_PROMPT,
        scheduledAt: resetsAtMs,
        localId: `auto-resume-${sid}-${resetsAtMs}`, // 必填，见下；稳定值顺带 reconnect 去重
        sentFrom: 'system',
    }).catch((e) => logger.warn(`[auto-resume] schedule failed for ${sid}: ${e}`));
},
```

> **`localId` 必填**（🔴 实测坑）：`store/messages.addMessage` 有硬 guard `scheduledAt != null && !localId → throw 'addMessage: scheduledAt requires a localId for the ack flow'`（`messages.ts:51`），而 `messageService.sendMessage` 不自动生成 localId（:519 透传 `payload.localId ?? undefined`）。web POST 不炸是因为它带了 `parsed.data.localId`。auto-resume 必须自生成一个稳定 localId。

> **`sentFrom:'system'`**：联合 `'telegram-bot' | 'webapp'`（`syncEngine.ts:571` / `messageService.ts:486`）**本就松、没强制**——`codexDesktop.ts` 已用 `'cli'` 越界。诚实起见把 `'system'` 加进联合（2 行），web 日后想要徽章不用再改 schema；现仅靠 prompt 文案自标「（系统自动恢复…）」识别。

> `sendMessage` 签名（`messageService.ts:480`）：`(sessionId, {text, localId?, attachments?, sentFrom?, scheduledAt?})`。`scheduledAt != null && attachments` 会被拒（:498），恢复提示纯文本无附件，安全。

### 6.4 去重 / 防循环

- **同条消息不会重复处理**：hook 跑在 `socket.on('message')` 入库路径，每条消息入库一次；reconnect backfill 不重跑 addMessage。
- **续上的 turn 又撞 `[1308]`**（reset 时间被推后）：新 `<synthetic>` 消息入库 → 再排程到新 reset 时间——符合预期（按新时间重排），自然收敛。reschedule cap 见 §11（MVP 不加）。
- **限额期内用户手动发消息**：用户消息是独立行，与 scheduled 恢复行并存；到点的恢复行照常 emit。若用户不想自动续，可经 web `DELETE /sessions/:id/messages/:messageId`（现成）取消那条 scheduled 恢复行——无需特殊接线。

### 6.5 `[1302]` rate-limit auto-resume（退避 + 去重 + cap）

**触发**：`<synthetic>` + `[1302]` + "速率限制/控制请求频率"（**无 reset 时间**）。实测落库（live DB 多 session），SDK 10x retry 撑 ~3min（退避 3s→38s）耗尽 → 终态 → 会话 idle。限流可持续 ~16min（实测）>> SDK 撑的总时长 → **治本无解**（调 `maxRetries` 收益限、代价大），退避兜底。

**和 `[1308]` 区别**：无 reset 时间 → 不能排到确定时刻，用**退避重试**（`now + backoff`）。

**classify 扩展**：`classifySyntheticError` 返回 `{kind:'quota',code,resetsAtMs} | {kind:'rate',code} | null`。rate regex `/\[(\d+)\][^\]]*?(?:速率限制|控制请求频率)/`（首个 `[纯数字]` + 速率关键词，无时间）。

**退避（`computeRateBackoff` 纯函数，DB 推断档位，无新状态）**：tier = 该 session 最近 30min 的 rate 恢复行数（localId 前缀 `auto-resume-rate-`，`store.messages` 加 `countRecentByLocalIdPrefix(sid, prefix, sinceMs)`）；`delay = 60s × 2^tier`（60/120/240/480/960s）；**cap**：tier ≥ 5 → null（**静默停**，不叫人，会话 idle 等人手）。

**去重（防密集风暴）**：限流密集时 ~80s 落一条 `[1302]`。localId `auto-resume-rate-<sid>-<window>`（window = `floor(now/60s)`），addMessage 幂等 → **同 60s 窗口只排一条**。

**配置点（startHub）**：`onAutoResumeSchedule(sid, error)` switch `error.kind`：quota → §6.3（`scheduledAt: resetsAtMs + 60s buffer`——reset 时刻是 GLM 解除限额的瞬间，精确卡点发会撞墙，buffer 60s 避免恢复消息失败）；rate → `computeRateBackoff(sid, store)`，null（cap）不排，否则 `sendMessage({scheduledAt: now+delay, localId: auto-resume-rate-<sid>-<window>, sentFrom:'system'})`。

**RATE_RESUME_PROMPT**：同 QUOTA_RESUME_PROMPT 结构，标"（系统自动恢复：API 速率限制，已退避等待）"。

**回调签名变**：`onAutoResumeSchedule(sid, resetsAtMs, code)` → `(sid, error: SyntheticError)`；透传链三层 deps（server/index/sessionHandlers）字段类型同步。

**和 quota 协调**：同 session 可能两者都有，各自排（localId 前缀区分）；rate 档位计数只算 rate 行。

**局限**：续上又撞 → 循环（每次消耗一 turn），cap 5 档防护；CD 60s < 密集窗口 80s，靠去重兜。

---

## 7. 改动清单

| 文件 | 改动 |
|---|---|
| `hub/src/sync/autoResume.ts` | **新建**：`classifySyntheticQuotaError` + `QUOTA_RESUME_PROMPT` |
| `hub/src/sync/autoResume.test.ts` | **新建**：L1 纯函数单测 + 时区强化（§8.1） |
| `hub/src/socket/handlers/cli/sessionHandlers.test.ts` | **加**：L2 接线集成测（§8.2：production wiring + 负样本 spy callback + 过去/未来分叉 + malformed 区分 + hook 抛错隔离） |
| `hub/src/sync/messageService.test.ts` | **加**：L3 release **桥接**（1 条，复用既有 :921 契约，断 `/cli new-message` 不重复 release 行为测试）+ L4 持久化并入（§8.3/§8.4） |
| L6 探针脚本（**借鉴** `acpVerifyProbe` 的 deadline/清理/结果模式，**非同构**；落点待定） | **新建**：L6 live 探针（§8.6：spawnSession 配真 runner + 30–60s 轮询 `invoked_at` + 退出分类 PASS/FEATURE_FAIL/PREREQUISITE_FAIL/CLEANUP_FAIL），部署机跑 |
| `hub/src/socket/handlers/cli/sessionHandlers.ts` | `SessionHandlersDeps` 加 `onAutoResumeSchedule`（:65 类型 / :87 消费）+ addMessage 后 hook（:119 后，套 try/catch） |
| `hub/src/socket/server.ts` | `SocketServerDeps` 加字段（:46）+ 透传（:130） |
| `hub/src/startHub.ts`（配置点，:177） | 定义 `onAutoResumeSchedule`（:194 `onAttentionBump` 同处）→ `syncEngine.sendMessage({scheduledAt, localId, sentFrom:'system'})` |
| `hub/src/sync/{syncEngine,messageService}.ts` | `sentFrom` 联合加 `'system'`（:571 / :486） |

**不改**：cli（任何文件）、`SDKResultMessage` 类型、`rateLimitParser.ts`、Cursor/Codex launcher、shared 类型、DB schema（`scheduled_at` 早在）、web。

---

## 8. 验证（分层，全机械，loop 可照跑）

> **核心原则**：auto-resume 的功能行为（**到点续**）**不在默认机械门覆盖内**——`/health` 200、commit 校验、typecheck/test/build:web 绿，都证明不了"限额来了会续"。loop 判 green 必须基于 **L1+L2（机械门内）+ L3 桥接 + L6（live 门）**，不是默认门。§8.8「什么不算证据」是 loop 判定红线。
>
> 本节经 codebase 走查 + Codex 复审定稿（§8.0 记录走查结论 + 对 Codex 的修正）。

### 8.0 走查确认的可测性 + 修正

- **release 既有契约**：`messageService.test.ts:921-1054` 已覆盖 `/cli` emit / 不盖戳(pitfall #2) / 重启重发(:1009) / future skip / 已-invoked skip。→ **L3/L4 不重复造，只加桥接**（§8.3）。
- **功能链真相（订正 P0-2）**：runner 收恢复提示靠 `io.of('/cli').to('session:X').emit('update',{t:'new-message'})`（`messageService.ts:548/628`）；`publisher.emit({type:'scheduled-matured'})` **只喂 SSE/web**（`sseManager.ts:158`）。→ L3/L6 必断 `/cli new-message`，**不**断 publisher。
- **CLI 消费链**：CLI 连 hub `auth.sessionId`→`socket.join('session:X')`（`cli/index.ts:93`）→收 `update`/`new-message`（`apiSession.ts:367-372` `handleIncomingMessage`）→`emitMessagesConsumed`（`:880`）→hub `markMessagesInvoked` 盖戳 `invoked_at`。**ack 早于模型响应**（L6 不等 GLM turn）。
- **分叉边界**：`sendMessage` `isFutureScheduled = scheduledAt !== null && scheduledAt > Date.now()`（`messageService.ts:530`，严格 `>`，re-measure 防 TOCTOU）。过去/现在→即时 emit `/cli`；未来→入库等 tick。
- 🔴 **localId 幂等（修正 Codex hypothesis）**：`addMessage` localId 冲突→**幂等返回 existing，不抛错**（`messages.ts:54-61`）。deterministic `auto-resume-<sid>-<ms>` 重放天然防重复；续上又撞（新 resetsAtMs）→不同 localId→新行（符合 §6.4）。Codex 担心的"冲突抛错"不成立。
- 🔴 **L6 spawn 副作用（确认 Codex P1）**：`spawnSession` 起的是真 agent（`run.ts:289` `agent ?? 'claude'`，枚举无 mock），smoke runner 收恢复 prompt **会真调模型**，可能再撞 `[1308]` 生成第二条排程。缓解：隔离 namespace + 按 probe run-id 清派生排程行 + 最便宜 model。**无法完全消除**——L6 完整版的固有代价。
- 🔴 **假绿陷阱（pitfall #2）**：`releaseMatureScheduledMessages` 故意**不**调 `markMessagesInvoked`（靠 CLI `messages-consumed` ack 盖戳）。→ L3 断 `/cli emit`，不断 `invoked_at`；L6 才断 `invoked_at`（真 runner ack 了）。

### 8.1 L1 纯函数单测（`autoResume.test.ts`）

- 真 `<synthetic>` 1308 样本（§5 原文）→ `{code:'1308', resetsAtMs}`。
- **agent 手打讨论 1308**（`model:"glm-5.2"`, role:assistant, text 含 `[1308]…重置`）→ `null`（sentinel 门控）。
- transient 文本（`[1302]请您控制请求频率`，无 reset 时间，`<synthetic>`）→ `{kind:'rate', code:'1302'}`（§6.5 rate 分支，非 null）。
- `tool_result` 形（role:user, model:undefined）→ `null`。
- 非 output 信封 / 缺 data.message → `null`。
- 无 text block 的 `<synthetic>` → `null`。
- 🔴 **时区强化（P2）**：固定 `TZ=Asia/Shanghai` 跑，断**完整 epoch**（`new Date(resetsAtMs)` 的年月日时分秒全对），不只 `getHours()===16`（后者抓不到分秒错 + 依赖测试机 TZ）。

### 8.2 L2 接线集成测（`sessionHandlers.test.ts`，**核心**）

验 hook→schedule。fake-socket + 真 SQLite fixture，注入 `onAutoResumeSchedule` 接**真** `syncEngine.sendMessage`（不 mock 掉，否则没测接线）。

断言（每条防一类假绿）：
- 真 `<synthetic>` 1308 **未来** resetsAtMs → DB 行：`scheduled_at==resetsAtMs` & text==`QUOTA_RESUME_PROMPT` & `sentFrom=='system'` & localId 形如 `auto-resume-<sid>-<ms>` & 🔴 **`invoked_at IS NULL`** & **无即时 `/cli new-message`**（未来入库等 tick）。
- 🔴 **过去 resetsAtMs**（`scheduledAt<=now`）→ DB 行存在 + `scheduled_at` 保留 + **恰一次即时 `/cli new-message`** + ack 前 `invoked_at IS NULL`（:530 即时分叉）。未来/过去两分叉都测。
- 🔴 **负样本**（`model:'glm-5.2'` 同文本）→ 🔴 **spy `onAutoResumeSchedule` 零调用** + DB 恢复行集合差集为空（不只断总行数——防"hook 触发但 callback 失败"假绿）。
- 🔴 **malformed**（合法 message 外壳但缺 `data.message`/content 形状异常，**非** schema reject）→ 原始 synthetic 行入库 + 无恢复行 + handler 不向 socket 抛。
- 🔴 **hook 主动抛错**（注入 throw 的 callback）→ 原始 synthetic 行仍入库（try/catch 兜底）+ 后续消息正常处理。
- 正常 turn（`model:'glm-5.2'`）→ 不触发排程（回归）。
- 🔴 **production wiring（Codex P0-3，判 P1）**：补一例过生产组装入口（`startHub→server→sessionHandlers→syncEngine.sendMessage`），或抽 production factory 测——防 `startHub` 忘传 `onAutoResumeSchedule` 字段时 L2 假绿。

### 8.3 L3 release 桥接（`messageService.test.ts`，**瘦身后**）

🔴 **零新增 release 行为测试**（`/cli` emit / 不盖戳 / 重发 / future skip 已在 :921-1054）。只加**一条桥接断言**：auto-resume 产生的 scheduled 行（经 `syncEngine.sendMessage({scheduledAt, localId, sentFrom:'system'})` 落库）→ 直调 `releaseMatureScheduledMessages(resetsAtMs+1)` → 🔴 **断 `/cli` 收到含正确 id/localId 的 `new-message`**（`makeTrackingIo` 范式，:922 `cliEmitted`），**不**断 publisher（订正 P0-2）。证明 auto-resume 行进入既有 release 契约。

### 8.4 L4 持久化（并入 L3 桥接）

L3 桥接里加：写完 scheduled 行后 `getMatureScheduledMessages(resetsAtMs+1)` 命中（行落盘可重查）。重启重发已由 :1009 覆盖，不重复。

### 8.5 L5 真实样本回归（**降级为非阻塞诊断**，P1）

扫 `~/.hapi/hapi.db` 所有 `model:"<synthetic>"` 过 `classifySyntheticQuotaError`，**逐条带原因的分类统计**（不只 hit 率——非 quota synthetic 本就该 miss）。已知真样本 2026-07-19/20 三条（reset `16:02:10`/`21:20:31`/`21:05:45`），负样本 `model:"glm-5.2"`。

🔴 **降级**：fresh 环境 / 无样本 → `SKIP(no corpus)`，**不参与 green 判定**（否则 agent-dev-loop 在新机器卡死）。版本化脱敏真样本进 L1 corpus 作确定门。部署机 post-deploy 跑，**只告警不 block**。🔴 **不进 GitHub CI**。

### 8.6 L6 live 功能探针（**完整版，具体化**，P0-1/P1/④）

目的：静态全对但线上真 entry（socket `/cli` + 真 runner + 真 `messages-consumed` ack）某处断，只有 live 能抓。不等真限流。

🔴 **前置（P0-1）**：smoke session 必须有真消费者。链路：`syncEngine.spawnSession`（:830）→`rpcGateway.spawnSession`（:137）RPC `spawn-in-directory`（:155）→`run.ts:285` 起 agent→CLI 连 hub `auth.sessionId`→`join('session:X')`（`cli/index.ts:93`）。裸 socket emit **不**触发 spawn → 无 runner → `invoked_at` 永不盖戳。→ 探针先 `spawnSession` 给 smoke session 配真 runner（最便宜 model + 隔离 namespace），或**预置常驻 smoke session + attached runner**（避免动态 provisioning 故障混入功能判定）。

步骤（部署机，挂 `hapi-deploy-run` live 阶段）：
1. 确认 smoke session 有真 runner 在线（已 join `session:<sid>` room）。
2. Socket.IO client 连 `/cli`（auth smoke sessionId）emit `message`，content=构造 `<synthetic>` 1308，`resetsAtMs = now + 15s`（留 tick 余量）。
3. 查 hub DB：恢复行 `scheduled_at ≈ now+15s` & `sentFrom='system'` & localId 形如 `auto-resume-...`。
4. 🔴 **30–60s deadline 轮询**该行 `invoked_at`（不等固定 15s——5s tick + 调度抖动 + runner ack；ack 早于模型响应，不等 GLM turn）。绿 = 真 runner 收 `new-message`→`emitMessagesConsumed`→盖戳 = **整条真链路通**，loop live 门判 auto-resume 成立的唯一机械证据。
5. 清理：按 probe run-id 删 smoke session + **派生排程行**（smoke runner 真调模型可能再撞 `[1308]` 生成第二条，必须清）。

🔴 **退出分类（机器可判，P1）**：`PASS` / `FEATURE_FAIL`（行没盖戳）/ `PREREQUISITE_FAIL`（spawn 失败 / runner 离线 / token 失效 / DB 锁）/ `CLEANUP_FAIL`。输出 sid / localId / target time / observed timestamps。

🔴 **删"照 `acpVerifyProbe` 同构"（订正 ④）**：`acpVerifyProbe` 是 spawn 子进程讲 JSON-RPC stdio（`acpVerifyProbe.ts:2,15`），不经 hub socket/scheduled-send/messages-consumed，链路完全不同。只**借鉴其 deadline/清理/结构化结果模式**。

🔴 **固有代价**：smoke runner 真调模型（spawn 无 mock agent），接受；L6 完整版的不可消除成本。

端到端场景映射（原 §8.3 表归入对应 L 层，不丢）：`[1308]` 真续上→§8.8 长期生产观测；hub 重启不丢→L4+:1009；用户 web `DELETE`→现成能力回归；`scheduledAt` 过去→L2 过去分叉；续上又撞→L2 + L5；正常 turn 不触发→L2 回归。

### 8.7 机械门（repo 根，无副作用）

```bash
bun typecheck && bun run test && bun run build:web
```

`bun run test` 含 L1+L2+L3桥接+L4（落 `autoResume.test.ts`/`sessionHandlers.test.ts`/`messageService.test.ts`）。L5/L6 不在。

### 8.8 「什么不算证据」（loop 红线，措辞修正 ③）

- 🔴 **默认机械门绿 ≠ 对**：typecheck/build:web 不涉功能；`bun run test` 只有实现时把 L2 写进去才覆盖。🔴 **改机械**：让 vitest 对缺失/skip 的 auto-resume 用例 fail（`--testNamePattern` 或显式 `.test.ts` 存在性断言），**不靠 agent 肉眼确认文件**。
- 🔴 **`/health`+readiness+commit 绿 ≠ 对**：只证 hub 活/代码对。live 功能证据 = **L6 `PASS`**（+ L5 无新增未分类样本告警）。
- 🔴 **L6 `PREREQUISITE_FAIL` = 基础设施失败，不是 auto-resume 功能失败**（不触发功能回滚）。
- 🔴 **删"真 [1308] 续上 = 终极人验/人最终确认"**（与"全机械、loop 自己跑"冲突）。改为：**长期生产观测证据，非发布验收条件**。真限流续上由 L5/日志持续监测，不是 loop gate。

### 8.9 loop 各门挂点（L6 失败分类，P1）

| 门 | 放什么 | 失败动作 |
|---|---|---|
| 本地门（feature 分支） | L1+L2+L3桥接+L4（`bun run test`）+ typecheck + build:web | 改代码 |
| CI 门（PR） | 同本地门（GitHub CI；L5/L6 不在） | CI 红，block 合并 |
| live 验证门（部署后） | 默认活性探针（`/health`+readiness+commit）**+ L6 探针 + L5 诊断** | 🔴 **仅 L6 `FEATURE_FAIL` → Routine 回滚**（reset+restart，schema 没变无 DB restore）；`PREREQUISITE_FAIL`/`CLEANUP_FAIL` → 有限重试后停住报告（回滚代码无助） |

---

## 9. 局限（已知，可接受）

1. **SDK 空转 retry 开销**：`[1308]` 这类不可恢复错误，SDK 会 retry 到 `max_retries:10` 耗尽（实测 65 分钟）才发终态、`<synthetic>` 落库，v2 在此之后才接管。接受；优化见 §11。
2. **fire 时刻 hub/runner 都挂则顺延**：scheduled 行在 DB 不丢，但到点若 hub/runner 都挂，下次 hub 起 + 5s tick 才发（顺延至 hub 恢复后一个 tick 内）。可接受。
3. **措辞覆盖**：`[1308]` / reset 时间模板依赖 GLM 当前错误文本；GLM 改措辞会漏。靠 §8.4 扫样本补规则。sentinel `<synthetic>` + `[纯数字]` + `重置` 关键词较稳。
4. **Claude 专属**：不泛化共享 base，Cursor/Codex 不受益（Cursor 已自带 transient-retry；Codex 走 app-server 错误路径不同，后续）。
5. **quota 重复排程**：到点 fire 后若续上的 turn 又撞 `[1308]`（reset 推后）会再排程——符合预期（按新 reset 重排）；reschedule cap 见 §11。
6. **未知错误 / transient 不恢复**：`classifySyntheticQuotaError` 返回 null 的分支（transient `[1302]`/529、非限额错误）不自动续——避免把可恢复错误或真 bug 自动重放。transient 多被 SDK 10x retry 吃掉；真不可恢复交用户。

7. **时区假设**：reset 时间按 hub 进程本地 TZ 解析（`new Date(y,m-1,...)`），隐含 hub TZ == GLM 服务器 TZ。现均 CST（已验 `GMT+0800`）；hub 若迁 TZ 会偏（如 hub UTC 而 GLM CST → 晚 8h 续）。要稳可改显式 TZ 解析。
8. **`<synthetic>` sentinel 稳定性**：SDK 改这串就静默失效，与「措辞覆盖」（第 3 条）同类风险，靠 §8.4 扫样本发现。
9. **crash 窗口**：hub 在 `addMessage(<synthetic>)` 与 `sendMessage(resume)` 之间崩 → 重启不重跑 addMessage → 恢复永不排程。窄窗（两调用 ms 级间隔），MVP 接受；要绝对稳需启动时 reconcile（扫已落库未排程的 `<synthetic>`），见 §11 思路。

> v1 §9.1「timer 进程内不持久化」**已解决**（复用 scheduled-send），从本节删除。

---

## 10. 关联

- **`~/cc-monitor`**（外部参考）：`lib/hooks.sh:handle_stop_failure`（StopFailure + 屏幕抓 reset + episode 退避）、`lib/watchdog.sh`（cron 到 `quota_resets_at` 恢复）、`lib/tmux.sh:recover_session`（tmux send-keys 注入）。HAPI 换成「读落库 `<synthetic>` 文本」+「scheduled-send」+「hub 5s tick」。
- **memory `scheduled-send-works-via-runner`**：定时发送实测链路（web 设 `scheduledAt` → hub 存 → 5s tick `releaseMatureScheduledMessages` → emit `new-message` → runner 喂 agent）。v2 直接复用。
- **memory `cc-monitor-auto-resume-reference`**：v1 的索引/映射；v2 翻了其中「检测/调度留 CLI」的映射。
- **lark-bridge memory `claude-p-retry-result-error.md`**：retry/result 机制原始研究（`max_retries:10`、`subtype` 陷阱、`<synthetic>` 消息）。v2 的信号源查证基于此 + 本次 hub DB 实测。529 频发根因（智谱精确匹配 `x-anthropic-billing-header: cc_entrypoint=sdk-cli`，治本=本地代理 rewrite）——与本 spec 是两件事。
- **v1（git history）**：CLI `setTimeout` + `queue.unshift` 方案，已废弃，保留可查。

---

## 11. 不在本次范围

- **transient `[1302]`/529 自动重试**：SDK 内部 10x retry 已兜底；真要加再扩展 `classifySyntheticQuotaError` 返回 `{kind:'transient'}` 分支 + 退避（v1 §6.2.c 的 transient 调度可参考）。
- **泛化到共享 base / Codex backend**：Claude 专属先做；Codex 走 app-server 错误路径不同，单独 spec。
- **更早识别 `[1308]` 并 abort SDK 空转 retry**：当前等终态 `<synthetic>`（SDK 已 retry 65 分钟）。优化可在 launcher `onMessage` 识别持续 `api_retry` + synthetic `[1308]` 文本时主动 abort `claudeRemote()`，省空转。收益中、复杂度高，后续。
- **prompt 可配置**（settings 读 `recovery_message`，cc-monitor 式）。MVP 硬编码常量。
- **quota reschedule cap**（防 reset 反复推后无限重排）。MVP 靠「每轮新 reset 时间」自然收敛。
- **web 恢复消息徽章**：`sentFrom:'system'` v2 已进联合（顺手加），但 web 端专属渲染（「系统自动恢复」徽章）未做——现靠 prompt 文案自标识别。后续 web 侧补。
- **529 频发治本**（本地代理 rewrite `x-anthropic-billing-header`）。见 lark-bridge memory，独立工作。
