# Web 会话返回导航 — history 栈管理 spec

> fork: `veniai/hapi` · 工作目录 `/home/claw/projects/hapi` · 基线 `main`（feature→PR→main，2026-07；`work/current` 已废）
> 状态：**方案已定（2026-07-22 经 Codex 对抗复审 + 逐条 node_modules 复核修正），代码尚未改动**。本文件仅描述方案，未实现。
> 注：原 router.tsx 行号基于 read-position cleanup 上 live 前版本，已漂 +15~+34；下方已按当前 `feature/sync-upstream-claude` 刷新为函数名锚点 + 现行行号。
> 触发场景：手机端（普通浏览器 / PWA）按**系统返回手势**，在会话聊天页期望回到会话列表，实际却跳到**另一个会话页**。

---

## 0. TL;DR

- **bug**：手机系统返回手势在聊天页不回列表，而是退到别的会话页。
- **根因**：「会话 → 会话」切换用的是 `navigate` 默认的 **push**（压栈），导致浏览器 history 堆了一串会话页 `[/sessions, A, B, …]`；系统返回在会话之间逐层倒退，倒不到列表。（静态审查结论，尚未浏览器运行复现）
- **修复**：封装 `useOpenSession()`——**当前在列表路由（`/sessions` / `/sessions/` / `/`）时 push，否则 replace**。覆盖所有「打开一个会话」的入口。改完**从聊天页发起的跨会话切换**恒回列表；二级页（文件/终端）系统返回 → 聊天页（逐层语义完整保留）。
- **范围**：3 个跨会话入口必修（A 组）+ 2 个二级页→聊天页 toggle 改 replace（A′ 组）+ 2 个特殊流顺手 replace（C 组）+ 1 个新 hook 文件。**进入二级页的 push 一根不动**；二级页退回聊天页的 toggle 改 replace（同 sessionId，视图切换非导航）。
- **不变量降级（诚实声明）**：只保证「聊天页发起的跨会话切换」回列表。**不保证**全局栈至多一个 session entry——二级页切会话（§7）、应用内 `useAppGoBack` push（§9）仍有残留 entry 场景。

---

## 1. 背景 / 要解决的问题

用户在手机上用 HAPI（普通浏览器或安装的 PWA，**非 Telegram 环境**），期望的返回行为是**符合层级的逐层返回**：

| 当前位置 | 按系统返回，期望到 |
|---|---|
| 二级页（文件 / 终端 / 单文件） | 该会话的**聊天页** ✅（现状已正常） |
| 聊天页（会话主页） | **会话列表** ❌（现状坏了） |

**实测现象**（已与用户确认）：聊天页按系统返回手势 → 跳到**别的会话页**，不是列表，也不是退出 app。

二级页那一步是对的，**只有「聊天页 → 列表」这一步坏**。

---

## 2. 根因分析（已取证）

### 2.1 走的是浏览器 history，不是 memory history

`web/src/main.tsx:54-56`：

```js
const history = isTelegram
    ? createMemoryHistory({ initialEntries: [getInitialPath()] })
    : undefined   // ← 非 Telegram：TanStack Router 默认 browser history
```

普通浏览器 / PWA（用户场景）走 **browser history**，逐层返回本应天然成立。Telegram 环境走 memory history（URL 不变、与浏览器栈脱钩），**不在本 spec 范围**。

### 2.2 布局是「列表 / 详情」两层互斥模型

`web/src/router.tsx`：
- `:507` 列表容器：`isSessionsIndex ? 'flex' : 'hidden lg:flex'`——手机端仅在列表态显示。
- `:588` 详情容器：`isSessionsIndex ? 'hidden lg:flex' : 'flex'`——手机端在会话/二级页全屏覆盖列表。
- `:250` `isSessionsIndex = pathname === '/sessions' || '/sessions/'`——**含尾斜杠**，是 §5 边界的依据。

即手机端**视觉上只有两层**：列表 与 当前详情。但 history 栈却可能压了四五层——**视觉模型与 history 栈不一致**，是 bug 的结构性根源。

### 2.3 直接病因：会话→会话压栈

会话之间切换用的是 `navigate` 默认 push。复现路径：

1. 列表 → 打开会话 A（push，栈 = `[/sessions, A]`）
2. 在 A 里通过**待办浮标 / Toast 通知 / 桌面端列表**切到会话 B（**又 push**，栈 = `[/sessions, A, B]`）
3. 在 B 按系统返回 → 退一层 → **退到 A**（= 用户看到的「别的会话页」），再按才到列表

二级页返回正常的原因：文件 / 终端是「会话 A 内部」push（`[/sessions, A, A/files]`），退一层正好回 A，没跨会话。

> 一句话：**会话→会话该 replace 却 push，history 堆了一串会话页，系统返回在会话间挨个倒退，倒不到列表。**

---

## 3. 贯穿原则

1. **区分两种二级页 push**：(a) **进入**二级页（chat → files/terminal/file）的 push **一根不动**——那是「逐层返回」的基础，用户已认可现状；(b) 二级页**退回**聊天页的 toggle（`handleToggleFiles`/`handleToggleOutline`，files.tsx:331/338）当前用 push，会把聊天页叠到二级页之后 `[/sessions, A, A/files, A]`——**改 replace**（同 sessionId，是视图切换不是导航，Codex 复审修正）。
2. **列表 → 会话保持 push**：这是进入详情层的唯一入口，必须 push 才能保证返回到列表。
3. **会话 → 会话改 replace**：切换会话是「替换当前详情」，不是「叠一层」。栈深不增长。
4. **系统返回与浏览器 history 对齐**：不引入 popstate 拦截 / history hacking（脏、edge case 多）。只靠正确的 push/replace 让原生 history.back() 自然成立。
5. **Telegram memory history 分支不动**。

---

## 4. 目标 history 栈结构

```
正常态：    [/sessions, 当前会话]                       ← 聊天页返回 → 列表 ✅
带二级页：  [/sessions, 当前会话, 当前二级页]            ← 二级页返回 → 聊天页 ✅
列表态：    [/sessions]
```

**目标态**（从聊天页发起的切换）：栈里**至多一个**会话 entry（列表不算），二级页至多再叠一层。⚠️ 这是「目标态」非「全局保证」——二级页切会话 / 应用内 `useAppGoBack` push 仍会留残留 entry，见 §7.1。

---

## 5. 方案：`useOpenSession()` hook

**新文件** `web/src/hooks/useOpenSession.ts`（参考 `useAppGoBack.ts` 的写法）：

```ts
import { useCallback } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'

/**
 * 打开一个会话。当前在列表路由 → push（保留进入入口）；
 * 否则（会话页 / 二级页 / 任意位置切会话）→ replace（不压栈）。
 *
 * 目的：让手机系统返回手势在聊天页（从聊天页发起的跨会话切换后）恒回列表。
 * 不保证全局栈至多一个 entry（二级页切会话/应用内 back 有残留，见 §7.1）。
 */
export function useOpenSession(): (sessionId: string) => void {
    const navigate = useNavigate()
    const pathname = useLocation({ select: (l) => l.pathname })

    return useCallback((sessionId: string) => {
        const onList = isSessionsIndexPath(pathname)   // 含 '/sessions/'，见 §5.1
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            replace: !onList,
        })
    }, [navigate, pathname])
}
```

`isSessionsIndexPath(pathname)` = `pathname === '/sessions' || '/sessions/'`，与 `router.tsx:250` 的 `isSessionsIndex` 同源——**提取共享纯函数供两处复用**，避免边界再次漂移。

### 5.1 `/sessions/` 必须纳入（Codex 复审修正 · node_modules 取证）

初版判断只含 `/sessions` 和 `/`、漏 `/sessions/`，是**真 bug**：直接载入 `/sessions/`（书签/外链/手输/PWA start_url）时 `location.pathname === '/sessions/'` 真实存在，UI 走 `isSessionsIndex` 显示列表，但 useOpenSession 漏判 → 走 replace → 把列表 entry 替换成 session → 系统返回**离开 app**（比原 bug 更糟）。证据链：

- TanStack Router 默认 `trailingSlash: 'never'`（`router-core/src/path.ts:112`），但**只作用生成方向**（`resolvePath` 出 URL 去尾斜杠，`path.ts:162-164`）；
- **入站 pathname 不被改写**：`parseLocation`（`router.ts:1294`）走 `decodePath(pathname).path`，而 `decodePath` fast-path（`utils.ts:632-633`）对 `/sessions/`（无 `%`/`\`/控制字符）**原样返回**；
- 全 router-core **无**入站 trailing-slash → redirect 逻辑（`router.ts:2993` 的 `normalize` 只用于 `comparePaths` 比较）。

`/`（根）**不纳入** `isSessionsIndexPath`——与 `isSessionsIndex` 严格同源（只判 `/sessions` / `/sessions/`）；`/` 被 `<Navigate to="/sessions" replace />`（`router.tsx:1171`）瞬间规整，useOpenSession 不会在 `/` 触发，故 off-list → replace 无实际影响。search/hash 不影响（hook 选 `pathname`，query/hash 不在其内）。

---

## 6. 改动清单（入口分类）

### A 组 · 跨会话入口必修（当前 push → 改用 `useOpenSession`）

| 入口 | 位置 | 说明 |
|---|---|---|
| SessionList 选择会话 | `web/src/router.tsx:564`（`onSelect`） | 手机端从列表触发（push）；桌面端从会话页点列表切会话（replace）。`useOpenSession` 一并覆盖 |
| 待办浮标（FAB） | `web/src/components/PendingInboxFab.tsx:74`（`handleClick`） | 会话页点 FAB 切到 `first.id`，当前 push |
| Toast 通知点击 | `web/src/components/ToastContainer.tsx:27`（`onClick`） | 点 toast 切会话，当前 push；SSE toast 携带目标 sessionId（`hub/src/push/pushNotificationChannel.ts:120`） |

### A′ 组 · 二级页→聊天页 toggle（当前 push → 改 replace；**不跨会话但破坏不变量**，Codex 复审修正）

| 入口 | 位置 | 说明 |
|---|---|---|
| 收起文件面板 | `web/src/routes/sessions/files.tsx:331`（`handleToggleFiles`） | 同 sessionId，视图切换；当前 push 把聊天页叠到 `A/files` 之后 `[/sessions, A, A/files, A]` → 改 replace |
| 打开 outline | `web/src/routes/sessions/files.tsx:338`（`handleToggleOutline`） | 同上，目标 `/sessions/$sessionId?outline=true`，改 replace |

### B 组 · 已正确（**不动**，已是 `replace: true`）

佐证：原作者在部分路径已意识到此问题，只是没统一。

| 入口 | 位置 | 备注 |
|---|---|---|
| 重开错误会话 | `web/src/router.tsx:754` | 跨会话，replace 正确 |
| `resolvedSessionId` 跳转 | `web/src/router.tsx:889` | 跨会话，replace 正确 |
| outline 消费后规整 URL | `web/src/router.tsx:932`（`handleInitialOutlineConsumed`） | **非 session-opening 入口**：同 sessionId，清 `?outline=true` 的 URL 规整；列此只为证「已 replace」，不计入「打开会话入口」枚举 |
| chat `onSessionReopened` | `web/src/components/SessionChat.tsx:1308` | 跨会话，replace 正确 |
| **files `onSessionReopened`** | `web/src/routes/sessions/files.tsx:365` | **Codex 补漏**：跨会话跳到新 sessionId 的 `/files`，replace 正确；原清单漏列 |

### C 组 · 特殊流（单独判断）

| 入口 | 位置 | 处理 |
|---|---|---|
| 新建会话成功 | `web/src/router.tsx:1057-1063`（`handleSuccess`） | **保留 push**。首次进入详情层，必须 push 才能返回列表（前置先 `:1057` replace 到 `/sessions`，再 rAF `:1060` push 新会话，栈 = `[/sessions, newSession]`） |
| 重复会话合并重定向 | `web/src/router.tsx:367`（`redirectTarget.canonicalSessionId`） | 建议**改 replace**。去重后不应在栈里留指向已删 session 的旧 entry（否则返回触发 not-found redirect） |
| 分享 handoff | `web/src/routes/share/index.tsx:169`（`handlePickSession`） | 建议**改 replace**（产品判断，非代码事实）：分享交接完成后返回列表更合理（而非回分享页） |

---

## 7. 已知小尾巴（不阻塞，可后续收尾）

**场景**：正停在**二级页**（如 `/sessions/A/files`）时，点 FAB 切到会话 B。

- `useOpenSession` 此时 `pathname=/sessions/A/files` → 走 replace 分支。
- 但 replace 只替换**当前 entry**（`A/files` → `B`），栈底的 `A` 还在 → 栈 = `[/sessions, A, B]`。
- 在 B 按系统返回 → 退到 A（而非列表）。

**为什么浏览器 history 没法干净解决**：没有原生 API 把栈「重置」成 `[/sessions, B]`；两步法（先 replace 到 `/sessions` 再 push `B`）会引入闪烁/竞态，得不偿失。

**为何不阻塞**：
1. 需先确认手机端二级页是否渲染 FAB（`PendingInboxFab` 用 `matchRoute({ to: '/sessions/$sessionId', fuzzy: true })`，`PendingInboxFab.tsx:50`，二级页也匹配 → 可能渲染）；
2. 即便存在，「二级页切会话」比「聊天页切会话」（用户报告的核心场景）罕见得多；
3. 核心 bug（聊天页返回跳别的会话）被 §5 完全解决。

**若要彻底收尾**（后续独立 spec）：进会话时若当前非列表，先 `navigate({ to: '/sessions' })`（push）垫一层列表、再 `navigate({ to: '/sessions/$sessionId' })`（replace），或评估在 detail 层 mount 时 `history.pushState` 垫底。需单独验证竞态。

### 7.1 已知尾巴完整清单（破坏「栈至多一个 session entry」的场景，均不阻塞核心 bug）

1. **二级页切会话**（上文）：FAB/toast 在 `/sessions/A/files` 触发 → 栈残留 A（A 组修复对此 no-op，因 pathname 非列表走 replace）。
2. **应用内 `useAppGoBack` 先 push 再切会话**（§9）：`useAppGoBack.ts:20/40/47` 三处 push（`/sessions/new→/sessions`、`file→files`、子路由→parent）制造重复/二级 entry；与系统返回共用同一 browser history，之后再切会话，系统返回撞到这些残留。
3. **二级页 toggle 已修**（A′ 组）：修前 `[/sessions, A, A/files, A]`，修后 replace 不增长。

核心 bug（聊天页直接切会话后系统返回跳别的会话）由 A 组完全解决；上述尾巴是「全局不变量」未达成，独立于核心 bug。

---

## 8. 验证

### 8.1 机械（本地 feature 分支，无副作用）

```bash
bun typecheck && bun run test
```

`useAppGoBack.test.ts` 只测纯函数 `getSettingsBackTarget`，`file/terminal.test.tsx` 把 `useAppGoBack` 整个 mock 掉——改 navigate 的 push/replace 语义**不破坏现有测试**。新增 `useOpenSession.test.ts` 须覆盖（不止两条分支）：
- `/sessions` → push；`/sessions/` → **push**（§5.1 边界回归）；`/` → push；
- 会话页 `/sessions/A` → replace；二级页 `/sessions/A/files` → replace；
- 搭配 history 断言：列表→A→（FAB）B 后 back 目标 = `/sessions`；`/sessions/A/files`→B 后 back 目标 = A（§7 尾巴 1，回归锁定）；
- A′ 组 toggle：`/sessions/A/files` 点 toggle 后栈不增长（replace）。

### 8.2 手测（手机或 PWA）

| 路径 | 期望 |
|---|---|
| 列表 → 会话 A →（FAB/通知）会话 B → 系统返回 | **列表** ✅（修复前：退到 A） |
| 列表 → 会话 A → 文件页 → 系统返回 | 会话 A 聊天页 ✅（逐层保留） |
| 列表 → 会话 A → 终端页 → 系统返回 | 会话 A 聊天页 ✅ |
| 列表 → 会话 A → 系统返回 | 列表 ✅ |
| 新建会话成功 → 系统返回 | 列表 ✅（push 保留） |
| 直接载入 `/sessions/`（带尾斜杠）→ 点会话 → 系统返回 | 列表 ✅（§5.1 边界回归；修复前：离开 app） |
| 会话 A → 切 B → 切回 A（来回切） | 每个会话阅读位置仍停在离开时的位置 ✅ |

桌面端（split view）同样适用：会话页点列表切会话 → replace → 返回回列表。

**阅读位置回归保险**：静态分析已排除 push/replace 对 scroll restore 的影响——存（`onBeforeLoad`，按 `getScrollRestorationKey` = pathname 分桶）与取（`onRendered`）都挂在 location change 事件上，与 history action 无关（`router-core/src/scroll-restoration.ts:231/247`）。手测此行仅为兜底确认静态分析无盲点。

---

## 9. 不做什么（out of scope）

- **不改 `useAppGoBack`**（应用内左上角返回按钮）。它当前用 push（`useAppGoBack.ts:20/40/47` 三处），会制造重复/二级 entry 污染栈——**且与系统返回共用同一 browser history**，故应用内 back 后再切会话，系统返回也会撞到残留（§7.1 尾巴 2）。但**用户报告的核心场景是聊天页直接切会话后的系统返回**，不经应用内 back，A 组修复对此独立成立。如要达成系统返回全局一致，后续把 useAppGoBack 三处 push 也改 replace（让应用内 back 与系统返回语义统一）。记录在案，不在本 spec。
- **不动「进入」二级页的 push**（chat → files/terminal/file；及 files/terminal/file 之间的跳转）。A′ 组的二级页「退回」chat toggle 不在此列（已改 replace）。
- **不做 §7 的小尾巴彻底修复**（二级页切会话的栈残留）。
- **不动 Telegram memory history 分支**（`main.tsx:54-55`）。
- **不引入 popstate 拦截 / history hacking**。
