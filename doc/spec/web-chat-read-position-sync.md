# Web 双端处理进度与连续阅读 - Goal Spec

> 项目：`veniai/hapi` fork
> 基线：`work/current`，2026-07-19
> 状态：**需求重新定稿；等待按本 Goal Contract 实现**
> 取代：`Web 双端红点与阅读位置 - Go-ready v2`
> 触发场景：电脑与手机交替查看、回复多个并行 session；红点用于协同处理，聊天进入后从上次阅读边界继续向下读。

本文先规定产品结果和可验证行为，再给实现约束。实现不能为了迁就当前代码而改变本契约；契约需要变更时，必须先停下并由用户确认。

---

## 1. Goal Contract

### Outcome

交付一个在电脑和手机之间可协同处理 session 的 Web 聊天体验：

1. 红点准确表达“这个 session 产生了尚未处理的新结果”。
2. 点击进入只清除当前设备的红点；任一设备发送回复后，两端共同清除该 session 的红点。
3. 当前正在打开的 session 完成新结果时也必须亮红点。
4. 进入 session 后从最近阅读边界继续向下读，不跳到最新、不跑到顶部、不漏掉中间内容。
5. 除用户发送消息和其他明确的用户导航动作外，流式输出、SSE、内容重排均不得移动当前视口。
6. 阅读位置能力不得让 session 切换产生可感知的额外卡顿。

### Boundaries

**在范围内：**

- Web 红点、待处理队列、session 行状态和跨端清除语义。
- Web 聊天进入、切换、返回、刷新、PWA 冷启动后的阅读位置恢复。
- Hub/shared 为“共享已处理进度”“共享阅读锚点”“按锚点取消息窗口”提供的最小数据契约。
- 消息窗口向前、向后分页，以及切换性能所需的缓存和竞态控制。
- 与上述行为直接相关的单测、集成测试、浏览器 E2E 和部署验证。

**不在范围内：**

- 改造 CLI agent 执行、模型调用或上下文统计。
- 改变 Telegram、钉钉等通知渠道的发送策略。
- 把阅读位置实时同步成另一设备的像素位置。
- 当前 session 在另一设备滚动时，实时拖动本设备视口。
- 借本 Goal 重做整个 SessionList、聊天视觉设计或无关缓存。

### Observable Completion Conditions

以下条件必须全部有外部证据，不能只以代码审查或模型判断宣称完成：

1. §4 的红点状态机全部通过双端测试。
2. §5 的位置与滚动不变量全部通过浏览器测试。
3. §6 的 X/Y/Z 主场景在两端完整通过。
4. §7 的切换性能门通过，并且相较当前已部署基线无明显回归。
5. 恢复、SSE、发送、分页之间不存在双重初始加载或旧请求覆盖新 session。
6. `bun typecheck && bun run test && bun run build:web` 全部通过。
7. 目标浏览器 E2E 覆盖 reload、session 切换、chat/files 返回、双端红点、恢复中 SSE、恢复中发送和向下连续阅读。
8. 完成一次基于最终 commit 的自审，逐条对照本文验收矩阵，不以旧 spec 为准。

### Permission Envelope

**Allowed now：**

- 在 `work/current` 修改相关代码、测试和本文档。
- 运行本地 typecheck、测试、build、浏览器 E2E 和只读诊断。
- 产出经过验证的 commit。

**Requires later approval：**

- 如果需要提高 `SCHEMA_VERSION`：执行 live migration 前必须获得明确批准。
- 任何 DB restore、破坏性回滚或可能丢失 live 写入的操作。
- 超出项目 standing authorization 的部署操作。

**Forbidden：**

- 直接在 `deploy` 分支提交。
- 为绕过 migration gate 而复用语义不匹配的旧字段。
- 用自动滚到底、清空位置或延迟硬编码掩盖恢复竞态。
- 未经确认缩减本 Goal 的双端语义或性能要求。

**Current completion boundary：**

- Goal A：本地实现、测试、build、commit，达到 `ready-for-deploy`；若含 migration，则为 `ready-for-approval`。
- Goal B：按权限分支 promotion、部署和 live 验证；不属于 Goal A 的自动完成条件。

---

## 2. 产品模型

红点进度和阅读位置相关，但不是同一个状态。

### 2.1 处理进度

每个 session 有三个逻辑量：

- **最新待处理版本**：Hub 对该 session 最近一次需要用户处理的结果所分配的顺序。
- **本端已看版本**：当前设备通过明确点击进入已经看过的版本。
- **全局已处理版本**：任一设备发送回复时，Hub 确认已处理到的版本。

红点判定的不变量：

```text
亮 = 最新待处理版本 > max(本端已看版本, 全局已处理版本)
```

这里的“版本”是产品语义，不强制字段名；实现必须使用 Hub 可排序、不会受客户端时钟漂移影响的顺序。普通 `updatedAt` 不能直接充当该版本，因为用户发送、metadata 和连接状态也会更新它。

### 2.2 阅读位置

每个 session 可以有两类锚点：

- **本地精确锚点**：消息 ID、设备上的视口偏移、捕获顺序；用于同设备精确恢复。
- **共享语义锚点**：消息 ID、Hub 可比较的更新顺序；用于另一设备从相同阅读边界继续。

阅读锚点只在“进入或重新挂载 session”时参与定位。当前视口已经建立后，其他设备的锚点更新只能更新缓存，不能触发滚动。

### 2.3 未读起点

当没有可用阅读锚点但 session 有红点时，进入位置必须是本轮的阅读起点：

1. 优先使用触发本轮的用户消息或 Hub 提供的 attention 起点。
2. 否则使用第一条未读消息。
3. 不允许直接落到最新消息。

只有“没有本地锚点、没有共享锚点、也没有未读结果”的首次访问，才默认显示最新内容。

---

## 3. 核心不变量

### 3.1 红点不变量

1. **新结果两端亮**：Agent 产生新的待处理结果后，所有设备对该 session 都能判定为亮。
2. **当前 session 也亮**：selected、visible、foreground 均不能阻止新结果产生红点。
3. **点击只本端灭**：设备 A 明确点击进入 X，只推进 A 的本端已看版本；设备 B 保持亮。
4. **发送两端灭**：任一设备在 X 成功发送回复后，Hub 推进 X 的全局已处理版本，并广播到所有设备。
5. **发送失败不灭**：请求被 Hub/CLI 拒绝或网络失败时，不能推进全局已处理版本。
6. **并发不误灭**：发送与新结果并发时，只清除发送操作所观察到的版本；之后产生的新版本继续亮。
7. **切页不丢信号**：新结果产生时设备正停在该 session，也必须保留红点，直到本端再次明确进入或任一端成功发送。
8. **流式不刷版本**：同一轮流式 chunk 不反复创建待处理版本；完成态或真正需要输入的状态才创建。
9. **请求优先**：permission/input 等立即需要处理的请求沿用现有优先级，不被 thinking 遮蔽。

### 3.2 位置不变量

1. **发送置顶**：用户成功发起发送后，刚发送的用户消息位于视口顶部。
2. **回复不跟随**：Agent 流式输出、完成、SSE 更新、Markdown/代码/字体重排不主动移动视口。
3. **进入续读**：切换到 session 时，最近有效阅读边界位于视口顶部，后续内容在其下方。
4. **同端精确恢复**：同一设备切 session、chat/files/terminal 往返、刷新或 PWA 重开后，尽量恢复同一消息和原视口偏移。
5. **跨端语义恢复**：另一设备进入时可从较新的共享阅读边界继续，但不承诺像素一致。
6. **目标保护**：恢复真正成功前，不得把被截短的临时 `scrollTop` 写回覆盖原目标。
7. **单一进入事务**：同一 session 的一次进入只能有一个窗口加载/定位所有者；禁止 `fetchLatest` 与 locator 并行竞争。
8. **旧请求无效**：切到其他 session 后，旧 session 请求即使晚返回也不能改写当前视图或当前定位状态。
9. **显式导航例外**：用户手动滚动、大纲选择、加载更早、继续阅读按钮可以改变位置。
10. **继续阅读不跳底**：点击新消息/继续阅读提示时，从下一段未读内容继续；不得先拉完所有 newer 页再滚到最新。

---

## 4. 红点行为契约

### 4.1 产生红点

满足以下任一条件时创建新的待处理版本：

- Agent 本轮完成并产生了新的用户可见结果。
- Agent 发出 permission 或 input 请求。
- 现有产品定义中需要用户处理的 background/ready 结果完成。

不因以下事件单独创建：

- 用户自己的发送消息。
- 流式 chunk、token usage、metadata、心跳或连接状态变化。
- 仅仅打开、关闭或切换 session。

### 4.2 本端清除（规则 A）

- 用户通过 SessionList、红点、待处理浮窗或 deep link 明确进入 session，清除该设备当前看到的待处理版本。
- 该操作不写全局已处理版本，不影响其他设备。
- 新结果到达时页面恰好已 selected，不视为自动看过。

### 4.3 跨端清除（规则 B）

- 用户回复成功到达 Hub 后，Hub 原子地把发送前已存在的待处理版本标为全局已处理。
- 所有在线设备通过实时事件收敛；离线设备下次 GET session 时收敛。
- Web 可以乐观清除发送端显示，但失败必须恢复；其他端以 Hub 确认为准。
- scheduled message 只有真正进入发送/消费语义时才清除，创建计划本身不等于处理完成。

### 4.4 队列顺序

- 新进入待处理状态的 session 追加到队尾，不插到用户当前处理目标之前。
- 已在队列中的 session 再次更新不改变其相对顺序。
- 全局处理或本端点击导致本端不再亮时，从本端 actionable 队列移除。
- 当前 selected session 可以显示红点；浮窗是否跳向自身必须避免无意义导航，但不能因此删除其待处理状态。

---

## 5. 连续阅读契约

### 5.1 进入目标选择

一次 session 进入只选择一次目标，优先级如下：

1. 比较本地精确锚点与共享语义锚点的有效顺序，选择更新者。
2. 若本地锚点胜出，恢复消息和本设备像素偏移。
3. 若共享锚点胜出，把该消息放到视口顶部。
4. 两者都没有但 session 有待处理版本，使用未读起点。
5. 都没有时显示最新内容。

选择完成后，SSE 带来的新共享锚点不得替换本次目标。

### 5.2 目标窗口

- 如果缓存已含目标和足够的后续消息，立即使用缓存，不发阻塞请求。
- 如果缓存不含目标，只请求以目标为中心的一窗消息，同时返回 older/newer 游标。
- 初始窗口必须包含目标之后的一段内容，使用户进入后可以立即向下读。
- 禁止为了进入 session 串行加载到最新。
- 接近窗口下沿时提前加载下一页；追加页面必须保持当前可见锚点。

### 5.3 位置保存

- 滚动后低频保存本地精确锚点；不得按每个流式 chunk 写 storage 或网络。
- pagehide、visibility hidden、session 卸载时上报共享语义锚点。
- 上报是非阻塞副作用，不能卡住路由切换。
- 恢复事务未完成时暂停位置写回；用户主动滚动可取消恢复并建立新锚点。
- 锚点消息不存在、被过滤或删除时，回退到邻近有效消息或未读起点；不得无条件滚到底。

### 5.4 新消息与继续阅读

- 当前不在最新窗口时，新消息进入 pending，不改变视口。
- “继续阅读/新消息”操作加载下一段 newer 内容并定位到第一条尚未展示的内容。
- 多页未读时允许逐段向下读；不得一次性跳过中间页。
- 用户自然滚到已加载窗口下沿时应提前预取，避免出现“看得到还有内容但向下滚不动”。

### 5.5 发送优先级

- 发送动作取消尚未完成的进入恢复，但不清空 durable 锚点，直到新用户消息可定位。
- 必要时补齐包含新用户消息的窗口，然后把它置顶。
- 发送定位优先于旧 locator、saved restore 和后台分页。
- 发送后的 Agent 输出仍不自动跟随。

---

## 6. 双端验收场景

### 6.1 电脑查看，手机回复

1. X 完成：电脑、手机均亮 X。
2. 电脑点击 X：电脑 X 灭；手机 X 仍亮。
3. 电脑阅读到位置 P，但不输入。
4. 手机点击 X：手机 X 灭，并从共享位置 P 继续向下读。
5. 手机成功发送回复：电脑、手机 X 均灭。

### 6.2 电脑直接回复

1. X 完成：两端均亮。
2. 电脑点击 X：仅电脑灭。
3. 电脑发送成功：手机 X 也灭。
4. 若发送后 X 又完成新一轮：两端重新亮。

### 6.3 X/Y/Z 连续处理

1. 电脑在 X，手机在 Y；Z 完成：两端均亮 Z。
2. 电脑点击 Z：仅电脑 Z 灭。
3. 电脑处理 Z 期间 X 完成，即使手机当时正停在 X，手机和电脑也必须记录 X 新红点。
4. 电脑回复 Z：两端 Z 全局灭。
5. 电脑点击 X；手机随后查看待处理队列，仍能通过 X 红点进入同一目标。
6. 任一端回复 X：两端 X 全局灭。

### 6.4 连续阅读

1. 长 session 在位置 P 后产生多页输出。
2. 用户切回该 session：P 位于顶部，不是最新消息。
3. P 之后已有可立即阅读的内容。
4. 用户向下阅读时下一页在接近边界前加载；视口不跳，且不会卡在旧窗口底部。

### 6.5 冷启动与竞态

1. 手机关闭 PWA 后重开：恢复同一 session 的有效阅读边界。
2. 恢复过程中收到 SSE：目标不变，新消息进入后续窗口或 pending。
3. 恢复过程中发送：旧恢复取消，新用户消息置顶。
4. 快速 X -> Y -> X：任何晚返回的 Y 请求不能覆盖 X。

---

## 7. 性能与体验门

这些条件与功能正确性同级，不能以“最终位置正确”替代。

1. 路由切换不等待 read-position POST、全量 newer 分页或无关 session 请求。
2. 已缓存目标窗口的 session，切换时不因本功能新增网络阻塞。
3. 未缓存目标窗口时，首屏只允许一条必要的目标窗口请求；不得同时启动 latest replacement。
4. 红点到达时不得同步遍历或加载完整历史。
5. 位置保存、跨端事件和 pending 排序不得形成按流式 token 频率的 React 重渲染。
6. 禁止依赖多轮固定 `setTimeout`、无限 ResizeObserver 重定位或无界 load-until-found 才能落位。
7. 使用 Playwright trace 或等价浏览器证据比较基线与目标 commit：重复切换 X/Y、冷缓存进入、热缓存返回均无新增长任务和明显交互停顿。
8. 性能证据必须记录测试设备/viewport、缓存状态、session 消息规模和目标 commit；只写“感觉不卡”不算完成。

本 Goal 不预设一个脱离环境的毫秒 SLA。若基线测量显示可稳定量化，再在实现计划中补充阈值，不得反向降低本节行为要求。

---

## 8. 实现约束与当前代码处置

本节约束风险，不强制具体类名或文件结构。

### 8.1 必须保留或复用的能力

- Hub 按 messageId 定位窗口及前后游标的能力，只要契约验证正确。
- 本地 durable message anchor，而不是只存裸 `scrollTop`。
- 消息窗口缓存、pending 隔离和分页时的 anchor-preserving merge。
- Hub 阅读位置存储和 SSE 数据链，只要改成本文的进入时消费语义。
- 已实现的待处理队列稳定排序原则。

### 8.2 必须重构的冲突

- `useMessages` 自动 `fetchLatest` 与 `SessionPage.loadInitial(locator)` 的双重 replacement。
- `HappyThread` 中 saved restore、locator、bottom intent、send positioning 互相争夺初始位置。
- selected/visible 自动推进本端已看水位，导致当前 session 完成时红点丢失。
- 以普通 `updatedAt` 同时承担 Agent 新结果、阅读和处理完成语义。
- “新消息按钮 = 拉完 newer 后滚到底”的错误假设。

### 8.3 推荐但不绑定的形态

- 一个可取消的 session-entry transaction：`choose target -> ensure window -> restore -> settle -> enable persistence`。
- Hub 单调 attention revision + shared handled revision；客户端保存 per-device seen revision。
- 缓存命中直接恢复，缓存未命中单次 locator；newer 靠邻近边界预取。

如果实现者选择其他形态，必须证明同样满足 §3、§6、§7，不能仅证明 happy path。

---

## 9. 验证矩阵

### 9.1 单元与集成测试

| 领域 | 必须覆盖 |
|---|---|
| 红点版本 | 两端亮、点击单端灭、发送两端灭、发送失败不灭、发送/完成并发不误灭 |
| 当前 session | selected 时完成仍亮；切走后信号仍在 |
| 队列 | 新项追加、重复更新不插队、全局处理后两端移除 |
| 目标选择 | local/shared 新旧比较、未读起点、无状态才 latest |
| 进入事务 | 单请求所有者、取消、旧响应丢弃、SSE 不换目标 |
| 恢复保护 | 内容不足不覆盖原位置、reflow 保 anchor、主动滚动取消恢复 |
| newer 阅读 | 分页逐段加载、预取、prepend/append 均不跳视口 |
| 发送定位 | 恢复中发送、新用户消息异步出现、失败路径、回复不跟随 |

### 9.2 浏览器 E2E

- 同 session：发送置顶，长回复不跟随。
- session A/B 来回切换：各自位置独立恢复。
- chat -> files/terminal -> chat：位置不变。
- reload、关闭/重开浏览器：位置恢复。
- locator 目标在缓存外：进入后可立即向下读，不跳 latest。
- 恢复中 SSE、恢复中发送、快速切换产生的晚响应。
- 两个 browser context 模拟电脑/手机，执行 §6.1-§6.3。
- 大于一个窗口的 newer 历史，验证逐段阅读和边界预取。

### 9.3 机械门

```bash
bun typecheck
bun run test
bun run build:web
```

涉及真实浏览器行为时，还必须运行目标 Playwright spec；不能用 jsdom helper 测试替代。

---

## 10. Goal 执行与发布

### Goal A - 实现与本地证据

1. 先建立当前基线 trace 和失败复现。
2. 先修正红点数据语义，再接 Web 显示与队列。
3. 重建单一 session-entry transaction，移除双加载和位置争夺。
4. 接入未读起点、目标窗口和向下预取。
5. 补齐 §9 测试并运行机械门。
6. 对最终 diff 做一次需求级自审，产出 commit 和证据摘要。

若实现中发现本契约无法同时满足，状态保持进行中，提交契约修订请求；不得把实现现状写回 Outcome 来假装完成。

### Goal B - Promotion、部署与 live 验证

- 无 schema 变化：满足项目 standing authorization 的机械条件后，按 routine deploy 流程执行。
- 有 schema 变化：Goal A 结束于 `ready-for-approval`；展示 target SHA、schema diff、DB snapshot/rollback 方案，等待明确批准。
- promotion 必须 `git merge --ff-only work/current`，live SHA 等于通过验证的目标 SHA。
- 部署后至少验证服务状态、公网资源版本、双端红点实时收敛和一个长 session 的进入/续读 smoke。
- live 失败按 permission envelope 回滚；DB restore 不自动执行。

---

## 11. 明确不接受的替代结果

- “最终能滚到某处”，但切换期间明显卡顿。
- 点击红点直接显示最后一条消息。
- 为了向下读，先同步拉取全部 newer 历史。
- 当前 session 因为 selected 而不亮红点。
- 点击进入后顺手把另一端红点清掉。
- 发送请求失败但两端红点已经消失。
- Hub 阅读位置 SSE 到达时拖动当前设备视口。
- 依赖 reload、反复切换或用户手动上翻才能恢复正确位置。
- 单测全绿但没有真实浏览器和双 context 证据。

---

## 12. 决策记录

| 日期 | 决策 | 原因 |
|---|---|---|
| 2026-07-19 | 红点拆为本端已看与全局已处理 | 点击是本端导航；发送才代表两端共同处理完成 |
| 2026-07-19 | 当前 session 完成也亮 | selected 不能吞掉之后跨设备导航所需的共享信号 |
| 2026-07-19 | 进入定位阅读边界，不定位最新 | 用户需要从上次读到的位置继续向下读，不能回头翻找 |
| 2026-07-19 | 新消息操作逐段续读，不滚到底 | 多页输出不能被跳过 |
| 2026-07-19 | 性能门与正确性同级 | 位置功能若让 session 切换卡顿，则产品结果失败 |
| 2026-07-19 | 局部重建 Web 进入链，不整仓回退 | 保留已完成的 Hub locator、缓存和独立通知能力，移除当前竞态根因 |

---

## 13. Human Acceptance Checklist

最终由用户按真实电脑+手机工作流确认：

- [ ] 当前 session 完成后也能看到红点。
- [ ] 电脑点开只清电脑；手机红点仍在。
- [ ] 任一端成功发送后，两端一起清除。
- [ ] X/Y/Z 连续处理时，两端能通过红点重新汇合到同一 session。
- [ ] 切入长 session 从阅读边界继续，不到顶部、不跳最新。
- [ ] 向下阅读不中断，不需要先上翻，也不会卡在旧窗口底部。
- [ ] Agent 回复和页面内容增长期间视口不动。
- [ ] 发送后自己的消息位于顶部。
- [ ] 切 session、切 files、刷新、关闭重开均能恢复。
- [ ] 上述能力没有让 session 切换出现可感知的新增卡顿。

只有机械证据通过且本清单由用户显式接受，Goal 才进入 `human-accepted`。

---

## 14. 实现状态（按 commit 增量，诚实记录）

> 本节记录各块相对契约的落地状态与已知偏离，供后续接手者验证。不替代上面的验收矩阵。

### G1 — 红点 revision 模型 + 发送两端灭（§2.1 / §3.1 / §4）

**已实现并通过机械门**（`work/current`，2026-07-19）：

- **Hub**：migration v11→v12 加 `attention_rev` + `handled_rev`（idempotent）。`bumpAttentionRev` / `advanceHandledRev`（atomic，后者幂等）。`sessionCache.bumpAttention` / `advanceHandled` 更新缓存 + 发 `session-updated {attentionRev|handledRev}`。
- **bump 点**（§4.1）：agent `ready` 事件（`isAgentResultContent`，非 chunk、非 user）→ unread；`update-state` requests 空→非空 → permission/input；`applyBackgroundTaskDelta` 0→N → background。**不**在 user send / chunk / metadata / 心跳上 bump（§4.1）。
- **send → 两端灭**（§3.1.4）：`syncEngine.sendMessage` 在 `messageService.sendMessage` 成功后 `advanceHandled`（§3.1.5：失败 throw 即不 advance）。
- **Web**：`sessionLastSeen` v2 key 存 per-device `seenRev`（不再存 updatedAt ms）。`classifySessionAttention` 拆 `classifyAttentionKind`（纯状态）+ `isAttentionLit`（`attentionRev > max(localSeenRev, handledRev)`）。`router` 盖 `attentionRev`；`SessionList` / `PendingInboxFab` 用新 option shape；`useSSE` patch summary 合并两 rev。
- **测试**：`migration-v12.test`（store 不变量）、`attentionRev.test`（hub 集成：ready/user/permission/background/send/idempotent/concurrency/persist，9 例）、`sessionAttention.test`（web §3.1.3–§3.1.6 全矩阵）。`bun typecheck && bun run test && bun run build:web` 全绿。`web/e2e/red-dot-send-clears-both.spec.ts`（HAPI_LIVE gated，§9.2 双 context 骨架，需 live 环境跑全）。

**已知偏离 / 待确认**：

1. **migration cut**：存量 session 两 rev 默认 0 → 部署后存量红点清空，直到下一个 attention 事件 bump。一次性迁移现象，符合新模型（旧 updatedAt-based 红点本就不该信）。
2. **unread 信号**：用 agent `ready` 事件（turn 完成）作 bump，沿用旧 updatedAt 路径已用的过滤（`shouldRecordSessionActivity` 对 agent 只认 ready）。若某 agent flavor 不发 ready 事件，其 unread 可能不 bump —— 与旧逻辑等价，非回归。background bump 在 0→N（启动）而非完成，对齐旧 UX（任务跑着就亮）。
3. **Goal B 待人批**：含 migration v12，live 部署需显式批准（standing auth 不预授权 migration）。部署前按 §10.2 验 deploy HEAD == target SHA + `user_version` 10→12 + integrity_check。

### G2 — 未读起点（§2.3 / §5.1）

**已实现**：hub 在 `bumpAttention` 带 `messageId`（agent ready 事件的消息 id）时，cache-only 记 `lastAttentionMessageId`（不入库，重启清空——可接受，重启后 web 走 saved/hub 锚点或 latest）。web entry（`router.tsx`）target 取 `saved ?? hub ?? (hasUnreadAttention ? lastAttentionMessageId : null)`——无锚点 + 有红点时落未读起点，不跳 latest。测试：`attentionRev.test.ts` 加「records the unread-start message id」一例。hub 535/web 1320 全绿。

**已知偏离**：`lastAttentionMessageId` 是 agent ready 事件消息（§2.3 偏好「触发本轮的 user 消息」——取 ready 事件而非其前的 user msg，是务实折中，落地结果边界、向下读）。hub 重启后丢失 → 该窄场景退化为 latest。

### G3 — 单一进入事务 + LWW 目标选择（§3.2.7 / §5.1 / §8.2）

**已实现**：
- 砍掉 `useMessages` 的自动 `fetchLatest` effect（commit 68e11ca 重加的「保底」）—— 它是与 `SessionPage.loadInitial(locator)` 并行争抢窗口的根因（§8.2 MUST-refactor）。现在 `loadInitial` 是唯一窗口加载 owner（locate 或 latest fallback），`isLoading` guard 从「救命」降级为「保险」。
- entry 目标选择抽成纯函数 `web/src/lib/read-position-target.ts` 的 `pickEntryTarget`，按 §5.1 LWW（`saved.capturedAt` vs `hub.lastReadAt`，tie/undated → saved）+ §2.3 unread-start + latest fallback。原 `saved ?? hub` saved-first 启发式替换。单测 10 例覆盖 LWW/tie/单边/undated/unread/latest 矩阵。
- web 159 文件 / 1330 测试全绿。

### G4 — 跨端恢复 + reporter/reload race（§3.2.4/§3.2.5）

**由 G3 的 LWW 选择根治**（无需单独改动）：
- **reporter POST/reload GET race**：reload 时 reporter pagehide POST（observedAt=T, msg=M）；POST 落地则 hub.lastReadAt≈T（tie→saved），未落地则 hub stale、`saved.capturedAt=T > hub.lastReadAt` → saved 胜 → 都定位到 M。两种情况都对。
- **跨端语义恢复**：设备 B 无/旧 saved + 设备 A 的新 hub 锚点 → LWW hub 胜 → 落共享边界；B 的 saved 更新 → saved 胜。§3.2.5 不承诺像素一致（locator 落 topOffset=0）由 HappyThread locator 模式承担（既有）。

### 待实现（G5）

- **G5（§7 性能证据 / §9.2 双 context e2e）**：无 Playwright trace 基线 vs 目标 commit 对比；`web/e2e/red-dot-send-clears-both.spec.ts` 双 context 骨架已写但 HAPI_LIVE gated，需 live 多端环境跑全。逻辑层由 attentionRev.test + sessionAttention.test 覆盖。

