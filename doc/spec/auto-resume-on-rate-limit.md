# Claude 会话断流 / 限额自动恢复（auto-continue）

> fork: `veniai/hapi` · 工作目录 `/home/claw/projects/hapi` · 基线 `work/current`（2026-07）
> 状态：**方案已定，代码尚未改动**。本文件仅描述方案，未实现。
> 触发场景：GLM 网关（`ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic`，glm-5.2）下，Claude remote 会话撞 429 瞬时限流（"断流"）或 5 小时使用限额，turn 终态失败 → 会话进 idle 卡死，要人去点"继续"。诉求：HAPI 自动发一段 continue 提示词续上。

---

## 0. TL;DR

- **痛点**：GLM 网关下两类 API 失败让 Claude 会话卡死——① 瞬时限流 `[1302]`（`请您控制请求频率`）；② 5 小时限额 `[1308]`（`已达到 5 小时的使用上限…将在 YYYY-MM-DD HH:MM:SS 重置`）。失败后 turn 结束、会话 idle，要人手动续。
- **Claude SDK 已内部 retry**（`max_retries:10` 指数退避，发 `system/api_retry`），瞬时 `[1302]` 通常自己扛过去；**retry 耗尽**才发终态 `result{is_error:true}`。实测一次 `[1308]` 限额 SDK 足足 retry 了 **65 分钟**（`duration_api_ms:3891936`）才放弃——纯属浪费，但终态 `result` 是 HAPI 的可靠挂载点。
- **检测**：挂 `claudeRemoteLauncher.ts` 的 `onMessage` 里 `message.type==='result'` 块，**只认 `is_error===true`**（陷阱：错误时 `subtype` 仍是 `"success"`，绝不用 subtype）。从 `result` 文本正则取 `[1308]…重置 <时间>`。
- **reset 时间在 result 文本里就有**（"将在 2026-07-17 16:01:19 重置"），**不用像 cc-monitor 抓终端屏幕**。
- **动作**：往 `session.queue.unshift(continue提示词, lastMode)`。turn 结束后 SDK 自动调 `nextMessage()` 从 queue 取——**零额外接线**，机制同 Cursor launcher 的 transient-retry 先例。
- **两场景**：`[1308]` 限额 → 解析 reset 时间 → 进程内 `setTimeout` 到点 unshift；瞬时 429/529 retry 耗尽 → unshift + 退避重试 + 连续上限 5。
- **范围**：新增 `cli/src/claude/utils/autoResume.ts`（纯函数 + prompt 常量）+ 测试；改 `claudeRemoteLauncher.ts`（闭包态 + result 判定 + 调度 + finally 清理）。**不碰 hub**（dumb 红线）、不改 `SDKResultMessage` 类型、不碰 Cursor/Codex、不动 DB schema。

---

## 1. 背景 / 痛点

用户跑 GLM 网关，Claude Code 会话频繁撞两种断流：

1. **瞬时 429（`[1302]`）**：`API Error: Request rejected (429) · [1302][您的账户已达到速率限制，请您控制请求频率]…`。白天高频发消息时易撞。
2. **5 小时限额（`[1308]`）**：`API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-07-17 16:01:19 重置。]`。

两类都让 turn 终态失败、会话进 idle。用户不在电脑前（HAPI 的核心场景就是远程控制）就得手动点"继续"，体验断裂。诉求：**HAPI 检测到这类终态失败时，自动重注入一段 continue 提示词续上**——瞬时走退避重试，5h 限额走到点恢复。

参考实现：`~/cc-monitor`（Claude Code/Codex 远程监控，bash + tmux + Claude 原生 hook）。已验证智谱 GLM 包月 5h 限额的自动恢复。

---

## 2. 现状走查（核查基准 `work/current`，2026-07，亲验 + 真实 log 数据）

### 2.1 Claude SDK 的 retry / result 机制（实测 log 铁证）

| 环节 | 证据 | 现状 |
|---|---|---|
| 内部 retry | `~/.hapi/logs/2026-07-18-20-29-53-pid-3112834.log:550-640` | SDK 发 `system/api_retry`：`{subtype:"api_retry", attempt, max_retries:10, retry_delay_ms, error_status:429, error:"rate_limit"}`。实测 attempt 1→4，`retry_delay_ms` 3000→4928（指数退避）。 |
| retry 耗尽 | `~/.hapi/logs/2026-07-17-08-11-54-pid-1706459.log:2711498-2711508` | 终态 `result{type:"result", subtype:"success", is_error:true, api_error_status:429, duration_api_ms:3891936, result:"API Error…[1308]…重置…"}`。**`duration_api_ms`≈65 分钟**——SDK 对限额错误空转 retry 了一小时。 |
| 错误码区分 | 同上 result 文本 | `[1308]`=5h 限额（带 reset 时间）；`[1302]`=瞬时限流（无 reset 时间）；`1305`/`529`=模型过载。 |

**关键陷阱（lark-bridge memory `claude-p-retry-result-error.md` 已踩过，HAPI 同样适用）**：错误时 **`subtype` 仍是 `"success"`**——判断失败**只认 `is_error` / `api_error_status` / `terminal_reason`**，绝不用 subtype。错误文本走 `result` 字段（不是 assistant text block，虽然也会同步出一条 `model:"<synthetic>"` 的 assistant 消息）。

### 2.2 HAPI 现有零件（两个半成品，没接上）

| 能力 | 位置 | 现状 |
|---|---|---|
| Claude 限流解析 + reset 时间 | `cli/src/agent/rateLimitParser.ts`、`cli/src/claude/utils/sdkToLogConverter.ts:200` `convertRateLimitEvent` | 解析 Anthropic 原生 `rate_limit_event` 的 `resetsAt`，**但只转成显示文本**（`"Claude AI usage limit reached\|{unix}\|{type}"`），不驱动恢复。**且 GLM 的 429 不走 `rate_limit_event`**（那是 Anthropic 自家限额事件），GLM 走 `api_retry` + 终态 `result`。 |
| 消息排队 + 自动重试先例 | `cli/src/cursor/cursorLegacyRemoteLauncher.ts`（`handleTransientAgentFailure`、`MAX_CONSECUTIVE_TRANSIENT_FAILURES=5`、`DEFAULT_TRANSIENT_BACKOFF_MS=2000`） | **Cursor 已有完整 transient-retry**：exit 1 + transient stderr → `session.queue.unshift(原消息, mode)` → 退避 → 上限 5 次丢。仅 Cursor，未泛化。 |
| 错误接住点（Claude） | `cli/src/claude/claudeRemoteLauncher.ts` `onMessage`（:121）的 `if (message.type === 'result')` 块（:258） | 现仅做 usage 载体（:260），**不识别 is_error、不重试**。← 挂载点。 |
| 重注入 API | `cli/src/utils/MessageQueue2.ts:151` `unshift(message, mode, localId?)` | 现成。Claude 的 `session.queue` 即 `MessageQueue2<EnhancedMode>`。 |

### 2.3 turn 结束后 continue 提示怎么被捡起

`claudeRemoteLauncher.ts` 的控制流（`runMainLoop`，:287 起 `while(!this.exitReason)`）：

1. `claudeRemote({...})`（:308）跑一个 turn，SDK 通过 `onMessage` 推所有消息，最后推终态 `result`。
2. `result{is_error:true}` 是**正常终态消息**（不抛异常）→ `claudeRemote()` 正常返回 → 外层 while 继续 → 下次 `claudeRemote()` → `nextMessage()`（:325）`await session.queue.waitForMessagesAndGetAsString()`（:341）**阻塞等下一条用户消息**。
3. 此时往 `session.queue.unshift(continue提示)` → 解除 :341 的阻塞 → 下一 turn 以 continue 提示为输入。

**所以"发继续" = 往 `session.queue` 塞一条消息，下个 turn 自动消费**。零额外接线，与 Cursor `unshift` 同构。

---

## 3. 根因（真实 log 铁证）

GLM 网关下 Claude turn 失败的完整时序（`2026-07-17-08-11-54-pid-1706459.log`，session `32d10ee5`）：

| 阶段 | 事件 | HAPI 现状 |
|---|---|---|
| 请求失败 | GLM 返回 429 `[1308]` | — |
| SDK 内部 retry | `api_retry` attempt 1…10，~65 分钟（`duration_api_ms:3891936`） | HAPI 透明转发 `api_retry` 事件，不干预 |
| retry 耗尽 | 终态 `result{is_error:true, subtype:"success", api_error_status:429, result:"…[1308]…将在 …重置…"}` | `onMessage` 的 result 块只做 usage 载体，**忽略 is_error** |
| turn 结束 | `claudeRemote()` 返回，`nextMessage()` 阻塞等输入 | 会话 idle，**等用户手动点"继续"** |

**病灶**：`claudeRemoteLauncher.ts:258` 的 result 块不识别 `is_error`，终态失败后无任何自动续接 → 会话卡在 idle。而续接所需的全部信息（失败信号 `is_error`、限额 reset 时间）**都在 result 消息里**，只是没人读。

> 注：`duration_api_ms:3891936`（65 分钟）说明 SDK 对 `[1308]` 这类不可恢复的限额错误会空转 retry 到耗尽。v1 接受这个开销（HAPI 在终态后接管）；未来可选优化见 §11（更早识别 `[1308]` 并 abort SDK 的无效 retry）。

---

## 4. 排除的路径（查证确定走不通 / 不采）

| 假设的信号 | 查证 | 结论 |
|---|---|---|
| Anthropic `rate_limit_event` 的 `resetsAt` | `rateLimitParser.ts` 已解析，但 **GLM 429 不发 `rate_limit_event`**（那是 Anthropic 自家限额），GLM 走 `api_retry` + 终态 `result` | ❌ GLM 路径没这个事件。 |
| `subtype` 判失败 | 实测错误时 `subtype:"success"`（:2711499） | ❌ **陷阱，绝不用**。 |
| cc-monitor 式抓终端屏幕取 reset 时间 | HAPI 用 SDK（`cli/src/claude/sdk/`），**无终端 pane** | ❌ 不适用；但 reset 时间已在 `result` 文本里，无需抓屏。 |
| 外部 cron watchdog（cc-monitor `*/5 * * * *`） | HAPI CLI 进程本身就是长驻 loop，进程内 `setTimeout` 即可；外部 cron 多余 | ❌ 不引入。 |
| hub 侧调度恢复 | 红线：hub 保持 dumb（不碰 LLM、推理放 agent 侧，见 memory `hub-stays-dumb-no-llm`） | ❌ 判定 + 调度全留 CLI。 |
| 重发原始用户消息（Cursor 式） | Claude 会话有完整上下文历史，重发原消息可能重做已部分完成的步骤 | ✗ 不采（用户已选 continue 提示词方案）。 |

---

## 5. 抓手：终态 `result` 文本里就有 reset 时间

`result.result` 字段（实测原文）：

```
API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-07-17 16:01:19 重置。][20260717143...
```

**性质**：
1. harness/GLM **注入的固定文本**（错误码 `[1308]` + 中文模板 + `将在 <时间> 重置`），不是模型随机生成 → 稳定可匹配。
2. 在**终态 result** 里到达 → `is_error:true` 时 hub/CLI 已能看到。
3. reset 时间格式固定 `YYYY-MM-DD HH:MM:SS`（空格分隔、无时区 → 本地时间，与 GLM 返回服务器本地时间一致；cc-monitor 的 `date -d` 也按本地时区）。

**正则**（quota）：`/\[(\d+)\][^\]]*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*重置/`
- `\[(\d+)\]` 捕获错误码（首个 `[纯数字]`，即 `[1308]`；`(429)` 是括号不算）。
- `[^\]]*?` 跨过 `已达到…将在 `（含 `[` 但不含 `]`，到末尾 `]` 前停）。
- 捕获 `2026-07-17 16:01:19` + `\s*重置`。
- 时间按**本地时区**解析：`new Date(y, m-1, d, h, mi, s).getTime()`（不用 `Date.parse` 空格串——虽 V8 非 ISO 当本地，但手解更稳、跨引擎无歧义）。

**正则**（transient，无 reset 时间）：`/\[(1302|1305)\]|529|rate[ _-]?limit|overloaded|\b429\b/i`

---

## 6. 方案

### 6.1 新 helper `cli/src/claude/utils/autoResume.ts`（**新建**）

纯函数 + 常量，可单测，对标 `rateLimitParser.ts` 模式。后续 Codex/其他 backend 可复用判定。

```ts
export type ResumeDecision =
    | { kind: 'quota'; resetsAtMs: number; code: string; raw: string }
    | { kind: 'transient'; code: string; raw: string };

const QUOTA_RESET_PATTERN = /\[(\d+)\][^\]]*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*重置/;
const TRANSIENT_PATTERN = /\[(1302|1305)\]|529|rate[ _-]?limit|overloaded|\b429\b/i;

/** 只在 is_error===true 时分类；成功 turn 或未知错误返回 null（不自动恢复）。 */
export function classifyResultError(
    result: string | undefined,
    isError: boolean
): ResumeDecision | null {
    if (!isError) return null;
    const raw = result ?? '';

    const q = raw.match(QUOTA_RESET_PATTERN);
    if (q) {
        const m = q[2].match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/)!;
        const resetsAtMs = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
        return { kind: 'quota', resetsAtMs, code: q[1], raw };
    }
    const t = raw.match(TRANSIENT_PATTERN);
    if (t) return { kind: 'transient', code: t[1] ?? t[0], raw };
    return null;   // 未知错误：不自动恢复（可能是真 bug，交给用户）
}

export const QUOTA_RESUME_PROMPT =
    '（系统自动恢复：API 5 小时限额已重置）临时中断，继续刚才的任务：' +
    '有 skill 必须调 Skill tool 并严格按 skill 流程执行（不得 inline 替代）；' +
    '单步过长可拆分但不跳过；已完成不重做。';
export const TRANSIENT_RESUME_PROMPT =
    '（系统自动重试：刚才 API 限流中断）继续刚才的任务。';
```

> prompt 文案复用 cc-monitor 的 `recovery_message`（已验证有效：引导 agent 读 TaskList、按 skill 流程、不重做已完成步骤），前缀标注系统自动恢复。MVP 硬编码常量；未来可按 settings 配置（见 §11）。

### 6.2 launcher 集成 `cli/src/claude/claudeRemoteLauncher.ts`

**a. 闭包态**（加在现有 `ongoingToolCalls`/`planModeToolCalls` 旁，:118-119，`onMessage`（:121）同层可见）：

```ts
// --- Auto-resume on transient/quota API failures (GLM gateway) ---
let lastMode: EnhancedMode | null = null;     // onMessage 判定用，nextMessage 里更新
let autoResumeCount = 0;                       // 连续 transient 失败计数
let quotaResumeScheduled = false;              // quota 已排程去重
let activeResumeTimer: ReturnType<typeof setTimeout> | null = null;
const TRANSIENT_RESUME_CAP = 5;
function clearResumeTimer() { if (activeResumeTimer !== null) { clearTimeout(activeResumeTimer); activeResumeTimer = null; } }
function scheduleAutoResume(decision: ResumeDecision) { /* 见 b/c */ }
```

> `onMessage` 是 `function onMessage(...)`（:121，非箭头），靠闭包访问这些 var（与 `ongoingToolCalls` 同模式），不用 `this`。

**b. quota 调度**（`scheduleAutoResume` 内，`decision.kind==='quota'`）：
- `if (quotaResumeScheduled) return;` 去重 → `quotaResumeScheduled = true`。
- `delay = Math.max(decision.resetsAtMs - Date.now(), 0)`。
- `session.client.sendSessionEvent({type:'message', message:`\`API 5 小时限额已满（${code}），${new Date(resetsAtMs).toLocaleString()} 自动恢复。\``})`。
- `activeResumeTimer = setTimeout(fire, delay)`，fire：`activeResumeTimer=null; quotaResumeScheduled=false;` 然后 `try { session.queue.unshift(QUOTA_RESUME_PROMPT, lastMode ?? fallbackMode); sendSessionEvent('限额已恢复，已自动继续。'); } catch { logger.debug('quota enqueue failed (queue closed?)'); }`。

**c. transient 调度**（`decision.kind==='transient'`）：
- `autoResumeCount++`。
- `if (autoResumeCount > TRANSIENT_RESUME_CAP)` → 通知 `连续 ${CAP} 次 API 失败，已停止自动重试，请手动检查`，return。
- 否则 `backoff = Math.min(60_000 * 2**(count-1), 5*60_000)`（60s→120s→…封顶 5min；SDK 已 retry ~分钟级，这里再叠）→ 通知 `API 限流（${code}），第 ${count} 次自动重试（${backoff/1000}s 后）` → `setTimeout(fire, backoff)`，fire：`try { session.queue.unshift(TRANSIENT_RESUME_PROMPT, lastMode ?? fallbackMode); } catch { ... }`。

`fallbackMode = lastMode ?? { permissionMode: session.permissionMode }`。

**d. `onMessage` 的 result 块**（:258）加判定：

```ts
if (message.type === 'result') {
    const resultMessage = message as SDKResultMessage;
    if (resultMessage.is_error === false) autoResumeCount = 0;   // 成功 turn 清零
    const decision = classifyResultError(resultMessage.result, resultMessage.is_error);
    if (decision) scheduleAutoResume(decision);
    if (shouldBuildResultUsageCarrier(resultMessage, sdkToLogConverter.needsResultUsageCarrier())) {
        messageQueue.enqueue(sdkToLogConverter.buildUsageCarrier(resultMessage.usage, resultMessage.num_turns));
    }
}
```

> 不改 `SDKResultMessage` 类型——只用已声明的 `is_error` + `result`。`api_error_status`/`terminal_reason` 运行时存在但 HAPI 未声明，本方案不需要（`is_error`+文本足够）。

**e. `nextMessage` 记 `lastMode`**（:350 `mode = msg.mode;` 后加）：`lastMode = msg.mode;`

**f. 手动接管取消 timer**（:343 `if (msg)` 内首行）：
```ts
if (msg && activeResumeTimer !== null) { clearResumeTimer(); quotaResumeScheduled = false; }
```
原理：auto-inject 的提示是 timer fire 时（先把 `activeResumeTimer=null` 再 unshift）才进 queue；故 nextMessage 取到消息时若 timer 仍非空，必是**用户手动续了**→取消自动恢复，避免重复注入。

**g. 清理**：timer **不在** per-iteration 内层 finally（:403，turn 间会跑，会误杀排程）清，只在 `runMainLoop` 外层 finally（:429）`clearResumeTimer()`（会话真正退出/abort/switch 时）。

---

## 7. 改动清单

| 文件 | 改动 |
|---|---|
| `cli/src/claude/utils/autoResume.ts` | **新建**：`classifyResultError` + `QUOTA_RESUME_PROMPT`/`TRANSIENT_RESUME_PROMPT` |
| `cli/src/claude/utils/autoResume.test.ts` | **新建**：单测（见 §8.1） |
| `cli/src/claude/claudeRemoteLauncher.ts` | 闭包态（~:119）+ result 块判定（:258）+ `scheduleAutoResume` + `nextMessage` 记 `lastMode`（:350）+ 手动接管取消（:343）+ 外层 finally 清 timer（:429） |

**不改**：hub（任何文件）、`SDKResultMessage` 类型、`rateLimitParser.ts`、Cursor/Codex launcher、shared 类型、DB schema、web。

---

## 8. 验证

### 8.1 单测 `autoResume.test.ts`

- `[1308]…将在 2026-07-17 16:01:19 重置` + `is_error:true` → `quota`，`resetsAtMs` = 该时刻本地时区 ms。
- `[1302]…请您控制请求频率` + `is_error:true` → `transient`。
- `529`/`overloaded`/`rate limit` + `is_error:true` → `transient`。
- `is_error:false`（成功 turn）→ `null`。
- `is_error:true` 但文本是无关错误（如 `"Error: tool execution failed"`）→ `null`（不自动恢复未知错误）。
- reset 时间本地时区：固定输入 `2026-07-17 16:01:19`，断言 `new Date(resetsAtMs).getHours()===16`（防 ISO/UTC 误解析）。

### 8.2 机械（`work/current`，无副作用）

```bash
bun typecheck && bun run test && bun run build:web
```

### 8.3 端到端（dev，需触发真限流）

| 路径 | 期望 |
|---|---|
| 瞬时 429（短时高频发消息撞 `[1302]`，或 10 点高峰 529）retry 耗尽 | web/chat 收到"API 限流，第 N 次自动重试"状态 + 会话自动续上，不进 idle 卡死 |
| `[1308]` 限额（难人为触发；可 mock result 走 launcher） | 收到"5 小时限额已满，HH:MM 自动恢复" + 到点 unshift continue 提示 + 续上 |
| 限额期间用户手动发消息 | 自动恢复 timer 被取消（§6.2.f），不重复注入 |
| 连续 5 次 transient 失败 | 停止自动重试 + 通知"请手动检查"，不死循环 |
| 正常成功 turn | 不触发任何排程、`autoResumeCount` 清零、无"自动恢复"提示（回归） |

### 8.4 真实样本回归

把 `~/.hapi/logs/*.log` 里所有 `result{is_error:true}` 的 `result` 文本过一遍 `classifyResultError`，确认 quota/transient/null 分类符合预期、reset 时间解析正确。已知样本：`2026-07-17-08-11-54-pid-1706459.log:2711505`（1308，16:01:19）、同 session 另一条（21:03:51 重置）。

---

## 9. 局限（已知，可接受）

1. **timer 进程内、不持久化**：`setTimeout` 在 CLI 进程里，runner/hub 重启会丢（5h 限额场景若期间重启，自动恢复失效，会话 idle 等人）。MVP 接受——session 在 runner 重启时本就断。未来要持久化见 §11。
2. **SDK 空转 retry 开销**：`[1308]` 这类不可恢复错误，SDK 会 retry 到 `max_retries:10` 耗尽（实测 65 分钟）才发终态 result，HAPI 在此之后才接管。v1 接受；优化见 §11。
3. **措辞覆盖**：`[1308]`/`[1302]`/`529`/reset 时间模板依赖 GLM 当前错误文本；GLM 改措辞会漏。靠 §8.4 扫样本补规则。transient 兜底匹配 `429`/`rate limit`/`overloaded` 较稳。
4. **Claude 专属**：不泛化到共享 base，Cursor/Codex 不受益（Cursor 已自带 transient-retry；Codex 走 app-server 错误路径不同，后续）。
5. **quota 重复排程**：到点 fire 后 `quotaResumeScheduled=false`，若续上的 turn 又撞 `[1308]`（reset 时间被推后）会再排程——符合预期（按新 reset 时间重排），但有上限更稳（§11 可加 reschedule cap）。
6. **未知错误不恢复**：`classifyResultError` 返回 null 的分支（如 `error_during_execution`、非 API 错误）不自动续——避免把真 bug 自动重放。需用户介入。

---

## 10. 关联

- **`~/cc-monitor`**（外部参考实现）：`lib/hooks.sh:handle_stop_failure`（StopFailure hook + 屏幕抓 reset 时间 + episode 退避）、`lib/watchdog.sh`（cron `*/5 * * * *` 到 `quota_resets_at` 恢复）、`lib/tmux.sh:recover_session`（tmux send-keys 注入 continue 提示）。HAPI 把"抓屏"换成"读 result 文本"、"tmux 注入"换成"`queue.unshift`"、"cron watchdog"换成"进程内 setTimeout"。
- **lark-bridge memory `claude-p-retry-result-error.md`**：retry/result 机制原始研究（`max_retries:10`、`subtype` 错误时仍 `"success"` 陷阱、`api_error_status`/`terminal_reason` 字段）。跨项目复用。另有 529 频发根因（智谱精确匹配 `x-anthropic-billing-header: cc_entrypoint=sdk-cli` 限流，治本=本地代理 rewrite header）——与本 spec 是两件事，本 spec 只做"断流后自动续上"。
- **`cli/src/cursor/cursorLegacyRemoteLauncher.ts`**：transient-retry 先例（unshift + 退避 + 上限 5），本方案 Claude 版与之同构。
- memory `cc-monitor-auto-resume-reference.md`：本 spec 的索引/映射。

---

## 11. 不在本次范围

- **泛化 transient-retry 到共享 base**（Cursor/Claude/Codex 共用）。Claude 专属先做；refactor 后续。
- **Codex backend**：走 app-server，错误路径不同（`will_retry` 字段，`appServerWrappedEvents.ts`），单独 spec。
- **更早识别 `[1308]` 并 abort SDK 的无效 retry**：当前等终态 result（SDK 已 retry 65 分钟）。优化可在 `onMessage` 识别 `api_retry` 持续 + synthetic assistant 的 `[1308]` 文本时主动 abort `claudeRemote()`，省掉空转。收益中、复杂度高，后续。
- **持久化调度**（runner 重启不丢恢复）：进程内 timer → 落盘/重启重建。需考虑 hub dumb 红线（调度可放 hub，但判定逻辑留 CLI）。后续。
- **prompt 可配置**（settings 读 `recovery_message`，cc-monitor 式）。MVP 硬编码常量。
- **quota reschedule cap**（防 reset 时间反复推后导致无限重排）。MVP 靠"每轮新 reset 时间"自然收敛；可加上限。
- **529 频发治本**（本地代理 rewrite `x-anthropic-billing-header`）。见 lark-bridge memory，独立工作。
