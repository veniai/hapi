# 后台子 Agent 触发红点 — backgroundTaskCount 漏计后台 Task spec

> fork: `veniai/hapi` · 工作目录 `/home/claw/projects/hapi` · 基线 `work/current`（2026-07）
> 状态：**方案已定，代码尚未改动**。本文件仅描述方案，未实现。
> 触发场景：Claude Code 派后台子 Agent（Agent tool，`run_in_background`）在后台跑、主 session 没结束、不需要用户处理时，web 红点仍亮。

---

## 0. TL;DR

- **bug**：agent 派后台子 Agent 在后台跑，主轮结束后系统误判 session 空闲 → 触发 `unread` 红点。用户不需要介入却被打扰。
- **根因**：`backgroundTaskCount`（后台任务计数）**只认 Bash 后台命令**（`"Command running in background with ID:"`），**不认 Agent tool 派的后台子 Agent**。主轮一结束、后台子 Agent 还在跑时，`bg=0` + `updatedAt` 已推进 → 命中 `unread`（`sessionAttention.ts:44`）。
- **查证排除**（确定走不通）：派生那一刻，**CLI 和 hub 都没有任何信号区分前台/后台 Task**——`run_in_background` 字段 93% 缺失、tool_use 块前后台字段完全相同、SDK 无 background 事件类型、CLI 无 background 处理分支。
- **抓手**（确定可行）：派生**之后立即**到的 `tool_result` 有 harness 注入的固定标识 `"Async agent launched successfully ... agentId: ... working in the background"`，在主轮内就到达 → hub 能据此 `+1`。
- **修复**：`hub/src/sync/backgroundTasks.ts` 的 `isBackgroundStartResult` 加认 Task 后台启动标识（现有 Bash bg 字面量保留）。完成侧 `<task-notification>` 已覆盖，不动。
- **范围**：hub 一个文件 + 测试。不碰 CLI、web 红点逻辑（`classifySessionAttention`）、shared 类型、DB schema。

---

## 1. 背景 / 痛点

用户报告：Claude Code 派子 Agent 在后台运行时（"派一个责任，你还得干"），主 session 没结束、不需要用户介入，但 web 红点还是亮。诉求：**只有 agent 真正需要介入（权限审批 / 回答 / 整轮彻底结束）才亮；agent 还在干活（含后台子 Agent 在跑）一律不打扰。**

现有红点逻辑大部分符合这个诉求（用户认可），**唯一不对的就是"后台子 Agent 在跑、主轮已结束"这个窗口**。

---

## 2. 现状走查（核查基准 `work/current`，2026-07，亲验 + 真实 jsonl 数据）

### 2.1 backgroundTaskCount 全链路

| 环节 | 位置 | 现状 |
|---|---|---|
| 字段定义 | `shared/src/schemas.ts:223`（Session）、`:247`（SessionPatch） | `backgroundTaskCount: z.number().optional()`。运行时字段，session 结束清零，不跨重启保留。 |
| 进 summary | `shared/src/sessionSummary.ts:147` | `backgroundTaskCount: session.backgroundTaskCount ?? 0`，直传。 |
| extractor | `hub/src/sync/backgroundTasks.ts:16` `extractBackgroundTaskDelta` | 从消息 content 推断 `{started, completed}` delta。**无状态。** |
| 启动识别(+1) | `backgroundTasks.ts:34` `countTaskStarts` → `:61` `isBackgroundStartResult` | **只认 tool_result 文本含 `"Command running in background with ID:"`**（Bash bg 专有）。← 病灶：Agent tool 后台派生**不**发这个字面量。 |
| 完成识别(-1) | `backgroundTasks.ts:76` `countTaskCompletions` | 认 user 消息 content 以 `<task-notification>` 开头。**覆盖所有后台任务完成**（Bash bg + Agent）。 |
| 调用点 | `hub/src/socket/handlers/cli/sessionHandlers.ts:139-142` | 每条消息调 `extractBackgroundTaskDelta(content)`，有 delta 就 `onBackgroundTaskDelta`。 |
| 落值 | `hub/src/sync/syncEngine.ts:423` → `sessionCache.applyBackgroundTaskDelta`（`sessionCache.ts:343-357`） | `prev + started - completed`，夹到 0。 |
| 清零 | `sessionCache.ts:406, 412` | session 结束（active=false）时硬清零。 |

### 2.2 红点判定（已对，不用动）

`web/src/lib/sessionAttention.ts:40-46`：

```ts
if (summary.active && (summary.backgroundTaskCount ?? 0) > 0) {
    return { kind: 'background' }   // 蓝点，不进 PendingInboxFab，不亮红
}
if (summary.updatedAt > options.lastSeenAt) {
    return { kind: 'unread' }       // 亮红
}
```

**逻辑本身符合诉求**："有后台任务在跑 → background（不打扰）；没后台任务 + 有新动静 → unread（亮）"。问题在 `backgroundTaskCount` **数据**漏了后台子 Agent。

---

## 3. 根因（真实 jsonl 铁证，session `32d10ee5`）

主 agent 派后台 Agent（codex-rescue，`run_in_background:true`，tool_use_id `call_6f64f47516ca49ad8d7a4949`）的完整时序：

| 时间 | 事件 | thinking | bg count |
|---|---|---|---|
| 00:16:33 | 派后台 Agent（tool_use）+ 立即收到 tool_result（"Async agent launched"） | true | **0**（Agent 没被算） |
| 00:17:31–00:17:40 | 主 agent 继续输出 | true | 0 |
| **00:17:40** | **主轮结束（result）→ `updateThinking(false)`**（`claudeRemote.ts:260`） | **false** | **0** |
| 00:17:40–00:20:50 | **空档 3 分钟，后台 Agent 还在跑** | false | 0 |
| 00:20:50 | 后台 Agent 完成，`<task-notification>` 回流 | false | 0 |

**00:17:40–00:20:50 这 3 分钟**：`thinking=false` + `backgroundTaskCount=0`（后台 Agent 没被算）+ `updatedAt` 已被 turn-ending 的 ready 事件推进 → 命中 `unread`（`sessionAttention.ts:44`）→ **红点亮**。用户没在看这个 session 就一直亮着。

> 注：不是任意 agent 输出都推进 `updatedAt`——`shouldRecordSessionActivity`（`sessionActivity.ts:39-54`）只记人类文本 + `ready` 事件。主轮结束的 ready 才是推进源，但足以触发 unread（症状成立）。

> 用户感知"派了就开始亮"：派完（00:16:33）到主轮结束（00:17:40）只差 1 分钟，且红点亮后不自动灭（要用户点进去更新 `lastSeenAt` 才灭），所以表现像"派完就亮"。

---

## 4. 排除的路径（查证确定走不通）

**核心约束：派生那一刻，CLI 和 hub 都无法区分前台/后台 Task。** 逐条排除：

| 假设的信号 | 查证（真实 jsonl 数据） | 结论 |
|---|---|---|
| `tool_use.input.run_in_background` 字段 | 29 个后台 Task 里 **27 个不带这字段**（Claude Code 默认后台、省略），2 个带 `true`；8 个前台也**全不带**；连标 `false` 的 codex 样本实际也是后台。 | ❌ 93% 缺失，前后台都缺失，**分不开**。 |
| tool_use 块字段结构 | 前后台都是 `{id, input, name, type}`，input 都是 `{description, prompt, run_in_background, subagent_type}`；`stop_reason` 都是 `tool_use`。 | ❌ **完全相同**。 |
| SDK background 事件类型 | 消息类型只有 `assistant`/`user`/`queue-operation`/`system`/`attachment`/`last-prompt`；SDK 类型（`cli/src/claude/sdk/types.ts`）只有 `isSidechain`。 | ❌ **无 background 专用事件**。 |
| CLI background 处理分支 | `claudeRemoteLauncher.ts` 只有 `isSidechain`（`parent_tool_use_id`）判断，无 background 分支。 | ❌ **CLI 和 hub 一样瞎**。 |

**结论**：Claude Code 前台/后台 Task 在消息流里**派生那一刻无任何区分信号**，唯一区分（后续有没有 `<task-notification>`）滞后、派生时不可知。所以"派生时靠字段/事件识别"或"CLI 判断后上报"都做不到。

---

## 5. 抓手：派生后立即到的 tool_result 有固定标识

派生**之后立即**（主轮内）到的 tool_result，Claude Code harness 注入固定元数据（真实 tool_result 块原始 JSON）：

```json
{ "type": "tool_result",
  "content": [{ "type": "text", "text":
    "Async agent launched successfully. (This tool result is internal metadata ...)
     agentId: a6353337731bafb48 ...
     The agent is working in the background. You will be notified automatically when it completes." }] }
```

**跨 subagent_type 一致**：走查确认 Explore / Plan / general-purpose / codex-rescue 的**后台**派生都用同一个 `"Async agent launched successfully"` 签名。

> ⚠️ `"Codex Task started in the background"`（codex-rescue 等）**不是**后台派生标识——那是 codex-rescue **前台**调用内部起的 codex job 文本（见 §6.1 警告、§9）。**不能**当模式匹配。

另有结构化信号 `toolUseResult: { isAsync: true, status: "async_launched" }`（raw jsonl 里有，32d10ee5:456），但 remote SDK converter 只用 `message` 重建 user 记录（`sdkToLogConverter.ts:227-249`），丢了这个顶层字段 → hub 收不到，文本标识是唯一通路。

**关键性质**：

1. harness **注入的固定文本**，不是模型随机生成 → 稳定可匹配。
2. 在**主轮内**到达（派生后立即）→ 主轮结束、`thinking=false` 时 hub 已能看到它。
3. hub 已能提取 tool_result 文本（现有 `isBackgroundStartResult:64-66` 已处理 content 是字符串 / text 数组两种情况）。

**所以**：在 `isBackgroundStartResult` 加认这个标识 → 后台子 Agent 派生后 `bg+1`，主轮结束时 `bg>0` → 走 `background`（不亮红）；子 Agent 完成发 `<task-notification>` → 现有 `countTaskCompletions` `-1` → `bg=0` 才可能 `unread`。

---

## 6. 方案

### 6.1 `hub/src/sync/backgroundTasks.ts`

`isBackgroundStartResult`（`:61-68`）加 Task 后台启动标识。当前只认 Bash bg，扩成模式列表：

```ts
const BACKGROUND_START_PATTERNS = [
    'Command running in background with ID:',   // 现有：Bash bg
    'Async agent launched successfully',         // 新增：Agent 后台派生（harness 固定签名）
]

function isBackgroundStartResult(block: Record<string, unknown>): boolean {
    const text = extractToolResultText(block)   // 把现有 :64-66 的 content 提取抽成函数复用
    return BACKGROUND_START_PATTERNS.some(p => text.includes(p))
}
```

> ⚠️ **绝不加宽泛的 `'started in the background'`**：走查（`547279b1`）发现 codex-rescue **前台**调用（`run_in_background:false`）的 tool_result 含 `"Codex Task started in the background as task-xxx"`（它内部又起了个 codex job）——匹配它会把这次前台调用误算 `+1` 且无对应 completion 永不归零，`backgroundTaskCount` 卡死。只认 harness 的 `"Async agent launched successfully"` 签名（前台同步 Task 的 tool_result 是真实输出，不含此签名）。

（把现有 `:64-66` 的 content 提取逻辑抽成 `extractToolResultText`，供 `isBackgroundStartResult` 复用。）

### 6.2 完成侧：不动

`countTaskCompletions`（`:76-91`）认所有 `<task-notification>` 开头的 user 消息，已覆盖后台子 Agent 完成。**不改。**

### 6.3 测试 `hub/src/sync/backgroundTasks.test.ts`（**新建**，当前不存在）

> 走查确认：`hub/src/sync/` 下**没有** `backgroundTasks.test.ts`，本 spec 测试是**新建**，不是改现有。

用例：

- Agent 后台派生 tool_result（`"Async agent launched successfully ... agentId: ..."`）→ `started=1`。
- **前台 codex-rescue 的 tool_result（`"Codex Task started in the background as task-xxx"`）→ `started=0`**（回归守护，防误加宽模式词）。
- 前台同步 Agent 的 tool_result（真实子 agent 输出，不含签名）→ `started=0`。
- Bash bg（`"Command running in background with ID:"`）→ `started=1`（保留原行为）。
- 配对：派生 `+1` 后，`<task-notification>` 完成 → delta 平衡。
- 重复通知：同一 task 多条 `<task-notification>` → `completed` 不重复减穿 0（`applyBackgroundTaskDelta` 夹负值，但需显式测试守护）。

---

## 7. 改动清单

| 文件 | 改动 |
|---|---|
| `hub/src/sync/backgroundTasks.ts` | `isBackgroundStartResult` 加 Task 后台标识 + 抽 `extractToolResultText` |
| `hub/src/sync/backgroundTasks.test.ts` | 4 条新用例（见 6.3） |

**不改**：CLI、`classifySessionAttention`、`PendingInboxFab`、shared 类型、DB schema、`<task-notification>` 完成识别。

---

## 8. 验证

### 8.1 机械（`work/current`，无副作用）

```bash
bun typecheck && bun run test
```

重点：`backgroundTasks.test.ts` 旧 + 新全绿。

### 8.2 措辞样本扫描（实现第一步）

把 `~/.claude/projects/*/**/*.jsonl` 里所有后台 Task 的 tool_result 文本扫一遍，grep `launched|started in the background|agentId:`，确认 `BACKGROUND_START_PATTERNS` 覆盖所有变体（不同 subagent_type）。漏的补进规则；最稳兜底字段是 `'agentId:'`（所有后台 Task 的 tool_result 都带）。

### 8.3 手测（dev）

| 路径 | 期望 |
|---|---|
| 在会话 A，会话 B 的 agent 派后台子 Agent | B 派完后、子 Agent 跑期间**不亮红点**（蓝点 background）；子 Agent 完成、整轮结束才可能 unread |
| 派前台同步子 Agent | 不影响（thinking 压制；且前台 tool_result 不含标识，不误 +1） |
| Bash 后台命令 | 不回归（现有标识保留） |
| 卡权限 / AskUserQuestion | 仍亮（`permission`/`input`，不受影响） |

---

## 9. 局限（已知，可接受）

1. **措辞覆盖**：不同 subagent_type / 未来 Claude Code 版本可能改 tool_result 措辞。靠 §8.2 扫样本补规则；最稳兜底 `'agentId:'`（所有后台派生的 tool_result 都带）。
2. **字面量匹配固有脆弱**：措辞变了会漏，跟现有 Bash bg 识别（`"Command running in background with ID:"`）同一性质，已在接受范围。
3. **完成侧依赖 Claude materialize**：`<task-notification>` 先以 `queue-operation/enqueue` 出现（`sessionScanner.ts:16` 跳过它），Claude 随后另写一条独立 `type:"user"` 记录，CLI 因 `<task-notification>` 是 system-injection prefix（`apiSession.ts:44-94`）当 agent output 转发，hub 才认（`countTaskCompletions`）。若 Claude 未 materialize / CLI 未转发，hub 收不到完成 → `bg` 不归零（卡在 background，不亮红，无害但不精确）。所以"完成侧全覆盖"说法偏强。
4. **无状态 delta 的固有局限**：`applyBackgroundTaskDelta`（`sessionCache.ts:343-357`）是无状态 `started - completed`。两个已知边角——① **重复通知**：通知 XML 明示同一 task-id "may notify more than once"，重复 `<task-notification>` 会多减（夹到 0，不穿负，但可能让另一个在跑的 task 看似完成）；② **completion-before-start**：若 completion 先到，`0-1` 夹到 0，后到的 start 永久 `+1`（卡 background，不亮红）。正常顺序（start → enqueue → user notification）不触发，但需 §6.3 测试守护。完全正确需 per-task identity（tool_use_id 配对），本 spec 不做（无状态更简单，边角仅"count 不精确"，不误亮红）。

---

## 10. 关联 spec（同一注意力模型）

- [`pending-inbox-thinking-mask.md`](pending-inbox-thinking-mask.md)：修"AskUserQuestion 该亮没亮"（thinking 遮蔽请求）。本 spec 修"后台 Task 不该亮却亮"（bg 漏计）。两者一正一反，共同细化"thinking=true 不打扰"的边界。
- [`dingtalk-visibility-suppression.md`](dingtalk-visibility-suppression.md)：外部渠道按可见性静音。本 spec 修好后，跨 session 的后台 Task 不再误亮红点，外部渠道的可见性抑制更安全。

三者各自独立实现，不合并文件。

---

## 11. 不在本次范围

- **不动 CLI 的 thinking 生命周期**（派后台 Task 时 thinking 该不该保持 true）。`thinking=false` 在主轮结束后为 true 本身没错（轮确实结束）；错的是 `backgroundTaskCount` 没算后台 Task。修数据，不修 thinking。
- **不动 `classifySessionAttention`**（background 分支逻辑已对）。
- **不动 `<task-notification>` 完成识别**（已覆盖）。
- **不引入 per-task 状态跟踪**（tool_use_id 配对）。靠 delta 计数（派生 `+1` / 完成 `-1`）足够，无状态更简单。前台同步 Task 的 tool_result 不含标识，不会误 `+1`，无需配对消减。
- **Monitor 工具**：Claude Code harness 层，不经过 HAPI、不进 hub，不触发 hub 红点。本 spec 不涉及。
