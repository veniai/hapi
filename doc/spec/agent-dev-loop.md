# Agent 开发闭环 — Cortex 控制平面视角（项目全流程）spec

> fork: `veniai/hapi` · 工作目录 `/home/claw/projects/hapi` · 基线 `work/current`（2026-07）
> 状态：**设计稿 v2（2026-07-18），Codex 审查 9 条已修；实现待落地**。
> 起源：卡兹克「哑铃」+ Cortex 控制平面，经本机 systemd live 适配。
> v2 修正：① 部署批准顺序（健康检查是证据不是批准）② promotion 步骤显式 ③ 现状 vs 待实现严格分开 ④ 回滚三路径 + DB 快照 ⑤ Cortex 角色收窄（非执行器）⑥ CI 门分类 ⑦ 探针分层 ⑧ 计数语义 ⑨ human-accepted 状态。

---

## 0. TL;DR

- **Cortex = 配置编译 + 任务指导**（project.md → AGENTS.md，手动 `cortex init`）。**不是执行器**——循环 / 计数 / 部署 / 通知由 **agent + `hapi-deploy-run`**（orchestrator）跑。
- **一个 agent 循环**贯穿 CI + promotion + 部署 + live 验证；任一环失败回改。
- **部署授权 = permission envelope 预先授权**（CI 过 + promotion 成功 → 允许 restart，无需当次人批）；**migration 类（改 `SCHEMA_VERSION`）单独要人批**。
- **部署顺序**：准备（build + DB 快照 + 基线）→ 授权（envelope）→ restart → 健康检查（**执行后证据**，失败触发回滚）。健康检查**不是**批准。
- **promotion 显式**：`work/current` CI 过 → `git merge --ff-only` 到 deploy worktree → 部署 deploy HEAD；**live SHA 必须等于 CI 过的 SHA**。
- **回滚三路径**（代码失败 / 部分迁移 / 迁移后失败），以**部署前 DB 快照**为基础。
- **人是验收点**；末尾 Finish 报告 → **human-accepted（显式状态）** → 洁癖 → 清理。

---

## 1. Cortex 真实角色（收窄，不夸大）

Cortex 是 **Codex-first 的配置控制平面**，只做三件：

| 做什么 | 机制 |
|---|---|
| **配置编译** | `.cortex/project.md`（源）→ `cortex init` → `AGENTS.md`（手动触发，**非自动同步**） |
| **任务指导** | 给 agent 规则 + **permission envelope**（权限边界）+ 薄 **Goal Contract** 形态 |
| **reconcile** | 现有配置对账（setup/init 时），不是运行时持续同步 |

**Cortex 不做**（v0.1 没有能力）：
- ❌ 跑 CI/CD 循环、计数、等 CI 结果
- ❌ 自动同步 project.md ↔ AGENTS.md ↔ codex（改 project.md 要手动 `cortex init`）
- ❌ 执行部署 / 回滚 / 通知

这些是 **orchestrator 的活 = agent（在 Cortex 规则下）+ `hapi-deploy-run`（部署/回滚/通知执行体）+ 计数状态文件**。spec 措辞不再把 Cortex 写成执行器。

---

## 2. 全流程（阶段 0-5）+ 每阶段谁干

```
[阶段 0 · 接入（一次性）]
  cortex init → project.md（事实 + native verification + permission envelope）→ AGENTS.md
  Cortex：编译配置；agent 共享同一份项目认知

[阶段 1 · 想法 → 方案]            （人 + Claude，暂缓自动化）  ← 前半
  人提想法 → AI 出方案 →（可选）Codex 纠错 → 定稿
  产出归档：方案/约束写进 doc/spec 或 project.md

[阶段 2 · 方案 → Goal + envelope]  （Cortex 画边界）          ← 前半
  薄 Goal Contract：目标 + done 条件 + 证据要求
  permission envelope 预先声明：
    - CI 过 + promotion 成功 → 允许 restart（自动，无需当次人批）
    - migration（改 SCHEMA_VERSION）→ 必须人批（回滚不安全）
  Goal 不能自行扩权。

[阶段 3 · 执行循环]              （agent + hapi-deploy-run）   ← 后半，定稿
  改代码（work/current 新分支）
  → 本地验证门：typecheck + test + build:web（在 work/current 跑）
  → 不过自修（attempt 计数，≤ K）
  → promotion：git merge --ff-only work/current → deploy worktree
  → SHA 绑定：记录 CI 过的 SHA = deploy HEAD = 即将部署的 SHA

[阶段 4 · 部署]                  （hapi-deploy-run）          ← 后半，定稿
  准备：build + DB 快照 + 捕获基线
  授权：envelope 已预先授权（CI+promotion 过）→ 直接 restart；migration 类等人批
  执行：systemctl restart
  验证（执行后证据，非批准）：/health + readiness + commit 校验
    失败 → 回滚（三路径，§5）

[阶段 5 · 验收 + 收尾]            （人 + agent）               ← 后半，定稿
  agent Finish 报告（达成 + 外部证据 + 未决不确定 + 未越边界）
  → human-accepted（人显式确认，独立状态）
  → 洁癖（规约端 reconcile + 代码/记忆端 agent 配合）
  → 清理（删分支，只消费 human-accepted）
```

---

## 3. Cortex 铁律（贯穿）

- **控制平面，非强制**——保留模型自由。
- **Goal 不能扩权**——越界（migration / 凭据 / 破坏性）要人批准。
- **别信模型 claim**——要外部证据（CI/live 绿勾 + commit 校验）。
- **对抗性验证**——证伪，不只 happy path。
- **破坏性操作两阶段**——准备 + 批准后执行（部署：准备 + envelope 授权 + 执行 + 验证）。

---

## 4. 执行循环（单循环，CI + promotion + 部署内嵌）

```
              ┌─────────────────────────────────────────────────────┐
              ▼                                                     │
目标: 无错误 + 上线   （一个 agent 循环，run 内 attempt ≤ K=8）
  │
  ├─ 改代码 (work/current 新分支)
  ├─ 本地验证门: typecheck + test + build:web    失败 → attempt++ → 回改
  ├─ promotion: git merge --ff-only → deploy; 记 CI 过的 SHA = deploy HEAD
  │     merge 冲突/失败 → 回改
  ├─ 部署: 准备(build+DB快照+基线) → restart → 验证(/health+ready+commit)
  │     验证失败 → 回滚(三路径,§5) → redeploy 计数 ≤ L=3 → 回改
  ├─ 都过 → 上线 (钉钉"发布成功")
  ├─ Finish 报告 → human-accepted (人确认)
  ├─ 洁癖 (规约端 reconcile + 代码/记忆端配合 + 复盘)
  └─ 清理 (删分支/worktree/临时 DB)

  attempt > K 或 redeploy > L → 保持回滚 + 钉钉叫人（退出循环）
```

**计数语义（执行器强制，非提示词）：**
- **run ID**：每次目标任务一个，持久化到 state 文件（如 `~/.hapi/deploy-runs/<run-id>.json`）。
- **attempt**：CI 失败 + promotion 失败 + 部署验证失败都计 attempt，≤ K。
- **redeploy**：仅部署验证失败后的重新部署计数，≤ L（每次 restart 杀在跑 agent 会话，更严）。
- **跨会话恢复**：agent 重启读 state 文件续跑；不靠内存。
- **强制者**：orchestrator（agent + 计数脚本），**不是 Cortex**。

---

## 5. 回滚（三路径 + DB 快照）

部署前**必做 DB 快照**：**SQLite backup API**（`sqlite3 ~/.hapi/hapi.db ".backup ~/.hapi/hapi.db.pre-deploy-<run-id>"` 或 bun:sqlite backup）——**非 cp**：hub 用 WAL，cp 主 db 漏 `-wal` 事务；快照后 `PRAGMA integrity_check` + 读 `user_version` 验证。回滚以快照为基础，不只靠 `user_version`。

| 失败情形 | 检测 | 恢复路径 |
|---|---|---|
| **代码失败，schema 未碰**（restart 前抛错 / 普通运行时挂） | `user_version` == 基线，且无 migration | `git reset` deploy 到 last-good + restart 旧版（最快） |
| **部分迁移**（migration 改了表结构，但 `user_version` 没 bump） | `user_version`==基线 但 schema 有未完成改动 | **DB 快照恢复** + reset 旧版（不靠 user_version 判，快照为准） |
| **迁移成功后启动失败**（`user_version` 已升，新版别处崩） | `user_version` > 基线 | **不能 reset 代码**（撞 mismatch）→ DB 快照恢复 + forward-fix 或留新版修 + 叫人 |

> 单一 `user_version` guard 不够（检测不了部分迁移，且「迁移后失败」无路径）。DB 快照是兜底基础。快照恢复会丢部署期间写入（部署 live 短暂中断，可接受）。
>
> **回滚拆（Codex 复审严重 3）：** Routine（schema 未变）= reset 到 last-good + restart，**无 DB restore**（standing auth 预授权）；任何 **DB restore（部分迁移 / 迁移后失败）进 `rollback-ready-for-approval`**（展示快照 + 当前 DB + 写入窗 + 预计丢失）→ **人 grant 后执行**（丢数据必须人批）。

---

## 6. 探针分层（验证证据，非批准）

部署后验证分四层，明确**哪层触发回滚**：

| 层 | 检查 | 失败动作 |
|---|---|---|
| **活性** | hub `/health` 200（免鉴权；migration 失败端口起不来） | 回滚 |
| **readiness** | DB 可读写 + runner 已连 | 回滚 |
| **commit 校验** | live 跑的 SHA == CI 过的目标 SHA | 回滚（部署错版本） |
| **公网 smoke**（可选） | `hapi.zhetengde.xyz` 可达 | 报警，不强制回滚 |

> 现 `hapi-deploy-run` 用 `/api/sessions`（401）+ web `/`；spec 统一切 `/health` + 加 readiness/commit——属**待实现**（§8）。

---

## 7. 部署授权（模式 b：预先 envelope + migration 单独人批）

```
准备（自动）：build:web + DB 快照 + 捕获基线（SHA + user_version）
授权：
  - 常规：envelope 已预先授权「CI 过 + promotion 成功」→ 无需当次人批，直接 restart
  - migration（本 run 改了 SCHEMA_VERSION）→ 必须人批（envelope 不预授权）
执行：systemctl restart hapi-hub hapi-web hapi-runner
验证（执行后证据）：§6 探针分层 → 失败触发 §5 回滚
```

**关键**：健康检查在 restart **之后**，是验证证据 / 回滚触发，**不是部署批准**。批准 = envelope 预先授权（常规）或人（migration）。

---

## 8. 现状 vs 待实现（严格分开，避免「写成已有」）

**现状（已落地）：**
- `hapi-deploy-run`：`bun install` + `bun typecheck` + `bun run build:web` + `systemctl restart` + web `/` + hub `/api/sessions`（401）检查。**无** test、**无**回滚、**无**通知、**无**计数、**无** DB 快照、**无** promotion SHA 绑定。
- `hapi-deploy`（wrapper，简陋）：`systemctl start hapi-deploy-job`。**无** fetch/merge。
- `hub/src/web/server.ts:225`：`/health` 端点存在（免鉴权），但**脚本未调用**。
- Cortex：`.cortex/project.md` + AGENTS.md 已接入；**循环规约已落 project.md**（2026-07-18：Native Verification 加 build:web gate + cli caveat；Permission Envelope 加部署两阶段状态机；Agent Dev Loop 节）→ `cortex init` 重编 AGENTS.md，doctor healthy。

**待实现（落地项）：**
- `hapi-deploy-run` 加：`bun run test`、STAGE + trap、回滚三路径、DB 快照、钉钉通知、`/health` 切换、readiness/commit 探针。
- `hapi-deploy` wrapper 加：fetch + `git merge --ff-only` + SHA 绑定 + `systemctl start --wait`。
- 计数：run ID + attempt/redeploy state 文件 + 跨会话恢复。
- human-accepted 状态记录。
- 循环规约落 `.cortex/project.md` → `cortex init`。

---

## 9. 收尾：Finish + human-accepted + 洁癖 + 清理

### 9.1 Finish 报告（agent 向人）
agent 收尾报四件：① 达成了什么 ② 外部证据（CI 绿 + live /health + commit 校验）③ 未决不确定 ④ 没越的权限边界。

### 9.2 human-accepted（显式状态，独立于 Finish）
Finish 报告 ≠ 验收。人**显式确认**（写 state：`human-accepted: <run-id>`）。**清理只消费这个状态**——防自动流程把 Finish 当确认、提前删分支。

### 9.3 洁癖（四端同步边界）
- **Cortex 管（规约端）**：`project.md` ↔ `AGENTS.md` ↔ codex 配置（手动 `cortex init` reconcile）。
- **agent 配合**：代码端（代码变 → project.md facts 更新）、记忆端（memory / doc/spec 沉淀）。

### 9.4 清理
删开发分支 / worktree / 临时 DB。仅消费 human-accepted。

---

## 10. 关键决策（带理由）

| 决策 | 值 / 做法 | 理由 |
|---|---|---|
| Cortex 角色 | **配置 + 指导，非执行器** | v0.1 只编译配置 + 指导任务；执行是 agent + hapi-deploy-run |
| 循环形态 | **单循环**，CI + promotion + 部署内嵌 | 目标模式 = 一个目标一直跑 |
| 部署授权 | **envelope 预先授权**（CI+promotion 过）+ **migration 人批** | 平衡自动化与安全；migration 回滚不安全需人知情 |
| 批准 vs 验证 | **健康检查 = 验证证据（restart 后），非批准** | restart 前验的是旧版；逻辑不能倒置 |
| promotion | **显式 `git merge --ff-only` + SHA 绑定** | 否则重复部署旧 HEAD；live SHA 必须等于 CI 过的 SHA |
| 回滚基础 | **DB 快照**（非单 user_version） | 三路径覆盖；user_version 检测不了部分迁移 |
| 计数 | **run ID + attempt/redeploy，执行器强制 + 持久化** | 跨会话恢复；上限不只写提示词 |
| 验收 | **human-accepted 显式状态** | Finish 报告 ≠ 验收；防提前清理 |
| CI 门 | **先本地验证门**（typecheck+test+build），GitHub CI 后置 | 现状脚本不跑 test；GitHub Actions 后接 |
| 人 | **验收点** | 非纯无人 |

---

## 11. 分阶段重点（当前）

- **当前 · 后半（阶段 3-5）**：设计稿 v2（本文件，Codex 审过）；下一步落 `project.md` + 实现 §8 待实现项。
- **前半（阶段 0-2）**：人 + Claude 现做，暂缓自动化；产出归档进 `project.md` / doc。
- **左端纠错环（可选，后置）**：方案让 Codex 审（卡兹克第二步）；HAPI 能跑 Codex。

---

## 12. 实现路线（落地顺序，记录免遗忘）

### ✅ 已 done
- **落 cortex**：`.cortex/project.md` 补 3 gap（Native Verification 加 `build:web` CI gate + cli integration caveat；Permission Envelope 加部署两阶段 Goal A/B；新增 Agent Dev Loop 节）→ `cortex init` 重编 AGENTS.md，doctor healthy。**Codex 复审 project.md 中**。

### 🔜 3a：失败兜底（回滚 + 通知 + DB 快照）— 改 `hapi-deploy-run`
- **DB 快照**：部署前 `cp ~/.hapi/hapi.db ~/.hapi/hapi.db.pre-deploy-<run-id>`（SQLite 文件 copy；migration 改 schema，回滚要恢复 DB）。
- **回滚三路径**（健康检查失败后，按 DB 状态选，见 §5）：代码失败 → reset + restart 旧版；部分迁移 → 快照恢复 + reset；迁移后失败 → 快照恢复 + 叫人。
- **钉钉通知**：bash curl 读 `~/.hapi/settings.json` webhook，推 成功 / 失败 / 已回滚 / 需人工。
- **效果**：部署失败不裸奔——自动回滚 live 恢复 或 通知人救。

### 🔜 3b：正确版本 + 防死循环（promotion SHA + 计数）— 改 wrapper + 加 state
- **promotion SHA 绑定**：wrapper 加 `git merge --ff-only work/current` → deploy；记 CI 过的 SHA = deploy HEAD；部署后校验 live SHA == 目标（防部署旧 / 错版本）。
- **计数**：run ID + attempt ≤ K=8（CI / promotion / 部署验证失败都计）+ redeploy ≤ L=3（仅部署验证失败重试）；持久化 `~/.hapi/deploy-runs/<run-id>.json`，跨会话恢复；超限 → 保持回滚 + 叫人。
- **效果**：部署的 = 验过的；循环不失控。

### 顺序
**3a 先（保命：失败兜底）→ 3b（精准：版本 / 控制）**。3a 改 hapi-deploy-run（独立、快见效）；3b 改 wrapper + 加 state。

### 抽象进 cortex（3a/3b 跑通后）
- **本质**：方法（语义：该做什么）进 cortex；执行器（机械：怎么做）留项目。cortex v0.1 不做执行器（product-design §10.2）。
- **落点**：cortex Skill 新增 `references/release.md`（product-design §3.3 / §8.1 预留的「发布方法」，references 现没写）。内容 = 本 spec 通用部分（剥离 HAPI 特定）：部署两阶段（引 permission-envelope）/ 回滚三路径 + 快照 / 通知 / 计数 / promotion SHA / 健康分层。
- **HAPI 特定留**：hapi-deploy-run bash / systemctl / 钉钉 curl / SQLite cp / git ff-only / 端点 → project.md + 脚本。
- **顺序**：HAPI 先实跑 3a/3b（dogfood）→ 验证管用 → 提炼进 cortex `release.md`（基于证据，不凭空；product-design §7.1 逻辑）。

### 其他（后置）
- 补测试：CI 加 `build:web`（已提为门）、关键 e2e、覆盖。
- CI 执行环境：GitHub Actions（public 免费）跑 CI 门。
- Codex 复审：project.md 审中；3a/3b 实现 + `release.md` 落地前再审。

---

## 13. 明确不做（本 spec 范围）

- 不把 Cortex 当执行器（它是配置 + 指导）。
- 不造洁癖 skill（现成的）。
- 不上 self-hosted runner / 自建云 CI（P3）。
- 不做纯无人（人始终验收）。
- 不自动化前半（阶段 1-2）。
