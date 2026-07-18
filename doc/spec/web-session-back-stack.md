# Web 会话返回导航 — history 栈管理 spec

> fork: `veniai/hapi` · 工作目录 `/home/claw/projects/hapi` · 基线 `work/current`（2026-07）
> 状态：**方案已定，代码尚未改动**。本文件仅描述方案，未实现。
> 触发场景：手机端（普通浏览器 / PWA）按**系统返回手势**，在会话聊天页期望回到会话列表，实际却跳到**另一个会话页**。

---

## 0. TL;DR

- **bug**：手机系统返回手势在聊天页不回列表，而是退到别的会话页。
- **根因**：「会话 → 会话」切换用的是 `navigate` 默认的 **push**（压栈），导致浏览器 history 堆了一串会话页 `[/sessions, A, B, …]`；系统返回在会话之间逐层倒退，倒不到列表。
- **修复**：封装 `useOpenSession()`——**当前在列表路由 `/sessions` 时 push，否则 replace**。覆盖所有「打开一个会话」的入口。改完栈恒为 `[/sessions, 当前会话]`，聊天页系统返回 → 列表；二级页（文件/终端）系统返回 → 聊天页（逐层语义完整保留）。
- **范围很窄**：3 个入口必修 + 2 个特殊流顺手 replace，外加 1 个新 hook 文件。**二级页的 push 一根不动。**

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
- `:492` 列表容器：`isSessionsIndex ? 'flex' : 'hidden lg:flex'`——手机端仅在 `/sessions` 显示。
- `:573` 详情容器：`isSessionsIndex ? 'hidden lg:flex' : 'flex'`——手机端在会话/二级页全屏覆盖列表。

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

1. **只动「打开一个会话」的入口**，二级页（files/terminal/file）的 push 语义**一根不动**——那是「逐层返回」的基础，用户已认可现状。
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

无论怎么切会话，栈里**至多一个**会话 entry（列表不算）。二级页至多再叠一层。

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
 * 目的：保证 history 栈恒为 [/sessions, 当前会话]，
 * 让手机系统返回手势在聊天页恒回列表。
 */
export function useOpenSession(): (sessionId: string) => void {
    const navigate = useNavigate()
    const pathname = useLocation({ select: (l) => l.pathname })

    return useCallback((sessionId: string) => {
        const onList = pathname === '/sessions' || pathname === '/'
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            replace: !onList,
        })
    }, [navigate, pathname])
}
```

**判断边界**：`pathname === '/sessions' || '/'`。`/` 会被 `<Navigate to="/sessions" replace />`（`router.tsx:1137-1140`）规整成 `/sessions`，两者都算「在列表」。

---

## 6. 改动清单（入口分类）

### A 组 · 必修（当前 push → 改用 `useOpenSession`）

| 入口 | 位置 | 说明 |
|---|---|---|
| SessionList 选择会话 | `web/src/router.tsx:549-552` | 手机端从列表触发（push）；桌面端从会话页点列表切会话（replace）。`useOpenSession` 一并覆盖 |
| 待办浮标（FAB） | `web/src/components/PendingInboxFab.tsx:67` | **强嫌疑**：会话页点 FAB 切到 `first.id`，当前 push |
| Toast 通知点击 | `web/src/components/ToastContainer.tsx:27-30` | 点 toast 切会话，当前 push |

### B 组 · 已正确（**不动**，已是 `replace: true`）

佐证：原作者在部分路径已意识到此问题，只是没统一。

| 入口 | 位置 |
|---|---|
| 重开错误会话 | `web/src/router.tsx:727-731` |
| `resolvedSessionId` 跳转 | `web/src/router.tsx:862-866` |
| outline 消费后规整 URL | `web/src/router.tsx:905-909` |
| `onSessionReopened`（重开新会话） | `web/src/components/SessionChat.tsx:1302-1306` |

### C 组 · 特殊流（单独判断）

| 入口 | 位置 | 处理 |
|---|---|---|
| 新建会话成功 | `web/src/router.tsx:1029-1032` | **保留 push**。首次进入详情层，必须 push 才能返回列表（前置的 `/sessions/new` 已在 `:1026` replace 到 `/sessions`，栈 = `[/sessions, newSession]`） |
| 重复会话合并重定向 | `web/src/router.tsx:351-354` | 建议**改 replace**。去重后不应在栈里留旧会话 entry |
| 分享 handoff | `web/src/routes/share/index.tsx:169` | 建议**改 replace**。分享交接完成后返回回列表更合理（而非回分享页） |

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

---

## 8. 验证

### 8.1 机械（`work/current` 本地，无副作用）

```bash
bun typecheck && bun run test
```

`useAppGoBack.test.ts` 只测纯函数 `getSettingsBackTarget`，`file/terminal.test.tsx` 把 `useAppGoBack` 整个 mock 掉——改 navigate 的 push/replace 语义**不破坏现有测试**。若新增 `useOpenSession.test.ts`，覆盖两条分支（列表 push / 非列表 replace）。

### 8.2 手测（手机或 PWA）

| 路径 | 期望 |
|---|---|
| 列表 → 会话 A →（FAB/通知）会话 B → 系统返回 | **列表** ✅（修复前：退到 A） |
| 列表 → 会话 A → 文件页 → 系统返回 | 会话 A 聊天页 ✅（逐层保留） |
| 列表 → 会话 A → 终端页 → 系统返回 | 会话 A 聊天页 ✅ |
| 列表 → 会话 A → 系统返回 | 列表 ✅ |
| 新建会话成功 → 系统返回 | 列表 ✅（push 保留） |

桌面端（split view）同样适用：会话页点列表切会话 → replace → 返回回列表。

---

## 9. 不做什么（out of scope）

- **不改 `useAppGoBack`**（应用内左上角返回按钮）。它当前也用 push（`useAppGoBack.ts:20/47`），同样会污染栈，但**用户报告的是系统返回手势，不是应用内按钮**。如后续发现应用内按钮也有同类问题，可顺带把它也改 replace（让系统返回与应用内返回语义统一）。记录在案，不在本 spec。
- **不动二级页 push**（files/terminal/file 之间及向 file 的跳转）。
- **不做 §7 的小尾巴彻底修复**（二级页切会话的栈残留）。
- **不动 Telegram memory history 分支**（`main.tsx:54-55`）。
- **不引入 popstate 拦截 / history hacking**。
