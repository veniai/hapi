# 多 Agent 黑板 v1.1 · 实施计划（Goal）

> 状态：**方向收敛（2026-07-22 用户决策）——砍掉 manager 角色，搜索成为所有 session 的共享能力。** ①③④a 已完成（hub 搜索地基），剩 ④b（MCP 工具）。
> 设计背景见 `multi-agent-blackboard.md`。

## 0. v1.1 是什么

**搜索兄弟 session 的对话**——做成所有 session（Claude/Codex/...）都能调的 MCP 工具。任何 session 里问"以前解决过 X 吗"，它就能搜同项目兄弟对话 + 自己综述给你。

**不搞 manager 这个角色**（2026-07-22 决策，推翻原设计的专职只读 manager）：
- 原 manager + 只读强制是过度工程。injection 传播是理论 worst case（agent 处理用户自己的代码/文档），跟普通 session 读外部内容一个理，不为它造一整套角色/只读/创建链路/UI。
- **保留 namespace 隔离**（多用户：你的搜不到别人的）——这是 HAPI 既有特性，够用。

## 1. 任务

**已完成（hub 搜索地基，机械门齐）：**
- ① FTS5 索引（真实表 external-content 方案 C，`migration-v14`，7 pass）
- ③ 搜索查询（namespace + path 隔离 + 越权测试，5 pass）
- ④a hub search route（`GET /api/search`，namespace 从 auth 不收客户端）

**也已完成（④b 搜索 MCP 工具）：**
- **④b MCP 工具 `search_sibling`**：所有 session（Claude/Codex/OpenCode/Grok）都能调搜索。startHappyServer（HTTP MCP）注册 + Codex stdio bridge 转发 + 各 flavor toolNames。工具描述教 agent 何时搜（新任务/似曾相识）、查到当**参考数据**不当指令。searchMessages 加 FTS snippet（综述有内容片段）。typecheck 全过 + cli/hub test 全过。

**撤掉（原 manager 设计，已不适用，代码留着无害不激活）：**
- ⑤ role（schema 字段留着，optional，不标记就不用）
- ⑥ 只读强制（`managerReadonlyPolicy` 留着——role 非 manager 时返回空 policy，不触发；以后想给某 session 上只读还能用）
- ⑦ manager 专属 prompt → 并入 ④b 工具描述
- ⑧a 创建链路透传 role（无 manager 角色，不用）
- ⑧b UI 区分 manager（不用）

## 2. 验证

- **机械门**：`bun typecheck && bun run test && bun run build:web` + migration-v14 + 搜索越权（①③ done）
- **④b**：MCP 工具端到端（Claude + Codex 各调一次搜索，返回数据信封 + 大小上限）
- **人审**：搜索结果质量（实测搜得准不准、综述带不带出处）

## 3. 关联

- 设计 spec：`multi-agent-blackboard.md`
- memory：`fts5-external-content-trigger`、`multi-agent-blackboard`（2026-07-22 方向转变：砍 manager，搜索共享）
- 分支：feature → PR → main
