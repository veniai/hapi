# 多 Agent LLM 辩论/共识 — 调研归档

> 归档于 2026-07-18。由 deep-research 工作流生成(104 agents / 4.4M tokens / ~54min)。
> 用途:为 HAPI v1.2「多 agent 需求讨论 → 意见稿」做设计背书(见 `doc/spec/multi-agent-blackboard.md` §v1.2)。
> 原始 JSON 输出曾在 `/tmp/.../w3mns61vy.output`(易失),本文件为持久归档。

---
## 问题
调研「多 agent LLM 辩论 / 审议 → 收敛出共识或统一立场文档」的现有做法、框架、已知坑,用于给一个新功能做设计背书。

【场景】要设计一个功能:2-3 个 AI agent(可能是不同框架/模型,例如 Claude Code + Kimi)就一个软件需求/设计问题辩论,多轮交换意见,最后收敛出一份统一「意见稿」,由一个中立的「manager」agent 主持。载体是 HAPI(本地多 agent 远程控制平台,已包 Claude Code/Codex/Kimi/Gemini/OpenCode)。

【需要覆盖】
1. 关键论文:多 agent LLM 辩论(Du et al.《Improving LLMs via Multi-Agent Debate》、《Minds in Harmony》、Mixture-of-Agents/MoA、society-of-mind 等)——它们用什么协议(轮流发言 vs 主持人 vs 辩论-批评 vs 投票 vs 自洽)。
2. 开源多 agent 编排框架里支持「辩论/共识」模式的:AutoGen、CAMEL、CrewAI、LangGraph、MetaGPT、OpenAI Swarm/AG2、ChatDev 等——哪些支持、怎么实现。
3. 已知坑:echo chamber / sycophancy / 崩塌式一致、groupthink、首发言者锚定、退化到「最差答案」、token/成本爆炸、不收敛、辩论反而比单个强模型更差。每条要找到具体证据。
4. 底层模型多样性(跨 vendor 辩论,如 Claude vs GPT vs Kimi)到底帮还是帮倒忙?有无实证。
5. 哪种收敛机制靠谱:主持人裁决 vs 固定轮数 vs 投票 vs self-consistency——推荐哪种。
6. 落到工程:如果要造一个「2-3 agent、主持人驱动、辩论到共识」的功能,具体设计建议 + 必须避开的反模式。

【输出要求】带来源链接的 cited 报告,重点是可落地的设计教训和要避开的老坑。今天是 2026 年 7 月。

## 统计
`angles`=5 | `sourcesFetched`=22 | `claimsExtracted`=108 | `claimsVerified`=25 | `confirmed`=15 | `killed`=4 | `unverified`=6 | `afterSynthesis`=8 | `urlDupes`=5 | `budgetDropped`=3 | `agentCalls`=104

---
## 综合结论 (Summary)
Multi-agent LLM debate (MAD) is a well-studied but fragile pattern. The canonical protocol (Du et al. 2023, ICML 2024) is fixed-round, turn-based rebuttal where multiple LLM instances propose answers, critique each other over N rounds, and converge toward a common answer — with NO neutral manager, NO voting, and NO self-consistency pass; this is the symmetric peer-to-peer baseline that subsequent frameworks copy. AutoGen's reference implementation concretizes this as solver agents + a non-LLM aggregator that distributes work and applies pure-Python majority voting, with sparse neighbor-topology and a fixed max_round (no consensus check / early-stop). The literature is near-unanimous on pitfalls: (a) sycophancy-driven premature consensus that can make debate WORSE than a single-agent baseline, decomposing into separate debater-driven and judge-driven failure modes (so the manager is itself a vector for collapse); (b) echo-chamber collapse-to-worst-answer on hard problems when agents see too many mostly-wrong peer solutions; (c) error/hallucination propagation amplified by LLM overconfidence; (d) cost explosion and coherence loss in long debates; and (e) the sobering meta-finding that default MAD does not reliably beat single-agent + strong prompts (few-shot) or self-consistency, and is markedly more hyperparameter-sensitive. Cross-vendor model diversity (e.g. Claude + Kimi) helps only under deliberate topology design — placing the stronger model at a high-centrality node — and the evidence is narrow (one task, ~1.2pp delta); heterogeneity is conditional, not a universal antidote (that stronger claim was refuted). For HAPI's 2-3-agent manager-driven feature, defensible design lessons are: (1) use a manager agent but treat it as a sycophancy surface, not a cure; (2) bound rounds with adaptive stopping against coherence loss; (3) prefer sparse/connect-with-subset topology over all-to-all; (4) the manager's convergence step must be LLM-based judgment/merge for open-ended design docs (majority voting does not apply); (5) benchmark against single-agent + strong-prompt baseline before shipping — do not assume debate wins.

---
## Verified Findings

### [0] HIGH · vote=4-1 combined
**Claim**: The canonical multi-agent debate (MAD) protocol (Du et al.) is multiple LLM instances proposing answers and debating their reasoning over multiple FIXED rounds toward a common final answer, using symmetric peer-to-peer critique with NO dedicated neutral manager/moderator, NO voting, and NO self-consistency pass. This fixed-round symmetric design is the baseline that subsequent debate frameworks copy and a known limitation later work addresses.

**Sources**: https://arxiv.org/abs/2305.14325

**Evidence**: Du et al. 'Improving LLMs via Multiagent Debate' (arXiv:2305.14325, ICML 2024, ~2375 citations). Abstract verbatim: 'multiple language model instances propose and debate their individual responses and reasoning processes over multiple rounds to arrive at a common final answer.' Project page confirms a fixed-round setup ('3 language models agents which debate for a total of two rounds'); the procedure is symmetric peer critique with no moderator/judge role. The abstract explicitly frames self-consistency as PRIOR complementary work, not a component of MAD. Later work (Gu AAAI 2026 'Dynamic Dialogue Framework', convergence-aware debate) adds judges/moderators precisely because this baseline lacks them. Votes: claim [0] 1-1, claim [1] 3-0.

### [1] HIGH · vote=2-0
**Claim**: Judge/manager-mediated debate (the MAD pattern: two debaters + a judge who monitors and manages the debate) reduces bias and distorted perception, but suffers HIGH compute cost on long debates and LLM coherence/relevance loss in extended scenarios — a concrete, named pitfall for the manager-driven design pattern.

**Sources**: https://arxiv.org/pdf/2501.06322 | https://arxiv.org/html/2501.06322v1

**Evidence**: Tran et al. 'Multi-Agent Collaboration Mechanisms: A Survey of LLMs' (arXiv:2501.06322, Jan 2025, 680+ citations). Verbatim from the MAD row: 'Two agents express their own arguments. A judge monitors and manages the debate. Reduce bias and distorted perception.' Plus: 'LLMs struggle to maintain coherence and relevance in long scenarios' and 'Frequent communication and multiple collaboration channels... can lead to increased computational cost and complexity.' Independently corroborated by Smit et al. ICML 2024 and Hu et al. NeurIPS 2025 (adaptive stopping designed specifically because long debates degrade coherence). Vote: 2-0.

### [2] HIGH · vote=4-0 combined
**Claim**: Multi-agent debate can yield LOWER accuracy than a single-agent baseline when sycophancy is present — debate can make the system actively worse. Sycophancy-driven collapse decomposes into DISTINCT debater-driven and judge-driven failure modes, meaning BOTH the debating agents AND the presiding judge/manager are separate vectors for premature disagreement collapse before a correct conclusion is reached.

**Sources**: https://arxiv.org/abs/2509.23055

**Evidence**: Yao et al. 'Peacemaker or Troublemaker: How Sycophancy Shapes Multi-Agent Debate' (arXiv:2509.23055, Sep 2025, UVA + Amazon Science, OpenReview forum hkBM5QkFVg, reproducible code). Abstract verbatim: sycophancy 'amplifies disagreement collapse before reaching a correct conclusion in multi-agent debates, yields lower accuracy than single-agent baselines, and arises from distinct debater-driven and judge-driven failure modes.' The framework studies 'how varying levels of sycophancy across agent roles (debaters and judges) affects outcomes in both decentralized and centralized debate frameworks' — directly establishing both roles as collapse vectors. Corroborated by Wynn et al. arXiv:2509.05396. Votes: claim [3] 2-0, claim [4] 2-0.

### [3] HIGH · vote=5-0 combined
**Claim**: Dense (fully-connected) multi-agent debate suffers echo-chamber / collapse-to-worst-answer failure on hard questions: when most peer answers are wrong, showing agents MORE reference solutions actively MISLEADS them into wrong answers, drastically reducing the likelihood of a correct response. Sparse (neighbor-subset) topology is the standard mitigation, matching or exceeding dense topology accuracy at materially lower token cost.

**Sources**: https://aclanthology.org/2024.findings-emnlp.427.pdf | https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/multi-agent-debate.html

**Evidence**: Li et al. 'Improving Multi-Agent Debate with Sparse Communication Topology' (EMNLP 2024 Findings, Google/DeepMind, 130+ citations). Section 5.4 verbatim: 'for more difficult questions, where most agents do not provide correct answers, an increase in the number of observed reference solutions tends to mislead the agent into choosing incorrect answers, thereby drastically reducing the likelihood of reaching a correct response.' AutoGen stable docs cite this paper verbatim as the rationale for connecting 'solver agents in a sparse manner' with each solver talking to only a subset of neighbors (not all-to-all). Votes: claim [5] 3-0, claim [9] 2-0.

### [4] MEDIUM · vote=2-0
**Claim**: Cross-vendor (heterogeneous-model) debate can help: weaker models are progressively strengthened by interacting with stronger models, and placing the stronger LLM at a high-centrality (high-degree) graph node yields better performance than periphery placement. BUT the evidence is narrow (one task, one model pair, ~1.2pp delta) — heterogeneity is a conditional benefit under deliberate topology design, NOT a universal antidote.

**Sources**: https://aclanthology.org/2024.findings-emnlp.427.pdf

**Evidence**: Li et al. EMNLP 2024 Findings, verbatim from Introduction: 'when agents are instantiated by different LLMs within the MAD framework, interactions among multiple LLMs allow weaker models to be progressively strengthened through engagement with stronger models. In non-regular graph settings, assigning stronger LLMs to agents with higher centrality consistently yields better performance.' Backed by Table 6 / Figure 6: GPT-3.5 (stronger) at degree-5 → 67.0±0.8 vs degree-1 → 65.8±0.5 on Anthropic-HH harmlessness (1 GPT-3.5 + 5 Mistral 7B). Caveats: ONE task, ONE model pair, borderline-significant delta; on the helpfulness split GPT-3.5 is actually weaker than Mistral 7B, so 'stronger' is task-dependent. The paper's own Limitations flag narrow model scope. The stronger 'universal antidote' claim was REFUTED (0-2) in adversarial voting. Vote: 2-0.

### [5] HIGH · vote=8-0 combined
**Claim**: AutoGen's canonical multi-agent debate pattern = solver agents + a separate 'aggregator' agent that distributes the problem, waits for final responses, and produces the converged answer WITHOUT LLM reasoning. Convergence is by pure-Python MAJORITY VOTING (max(set(answers), key=answers.count)), governed by a fixed max_round count — NO LLM-based judgment/merge, NO consensus check, NO early-stopping, NO manager deciding when agreement is reached. Sparse topology between solvers is the documented default.

**Sources**: https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/multi-agent-debate.html

**Evidence**: AutoGen v0.4 stable docs (primary, official). MathSolver.__init__ takes model_client; MathAggregator.__init__ takes only num_solvers — NO model_client. Aggregator code: 'majority_answer = max(set(answers), key=answers.count)'. Prose step 5: 'Repeat step 4 for a fixed number of rounds. In the final round, each solver agent publishes a final response.' Prose: 'The solver agents are connected in a sparse manner following the technique described in Improving Multi-Agent Debate with Sparse Communication Topology.' CAVEAT for HAPI: majority voting is viable ONLY for single-token comparable answers (the doc targets GSM8K numerals); for open-ended design/position documents, this convergence mechanism does not apply — an LLM-based manager merge is required. Votes: claim [7] 3-0, claim [8] 3-0, claim [10] 2-0.

### [6] HIGH · vote=9-0 combined
**Claim**: Default multi-agent debate does NOT reliably outperform simpler baselines — (a) a single-agent LLM with strong prompts (few-shot demonstrations) matches or beats a MAS with suboptimal collaboration-channel design across reasoning tasks and backbones; (b) MAD does not reliably outperform self-consistency and ensembling over multiple reasoning paths. MAD is NOT inherently worse, but is markedly more sensitive to hyperparameter settings and harder to optimize (e.g. Multi-Persona improves under tuning).

**Sources**: https://arxiv.org/html/2501.06322v1 | https://proceedings.mlr.press/v235/smit24a.html | https://arxiv.org/abs/2402.18272

**Evidence**: Smit et al. 'Should we be going MAD?' (ICML 2024 / PMLR 235, 120+ citations, primary) abstract verbatim: 'multi-agent debating systems, in their current form, do not reliably outperform other proposed prompting strategies, such as self-consistency and ensembling using multiple reasoning paths' and 'MAD protocols might not be inherently worse than other approaches, but that they are more sensitive to different hyperparameter settings and difficult to optimize.' Wang et al. 'Rethinking the Bounds of LLM Reasoning' (arXiv:2402.18272, ACL 2024, 262 citations): 'a single-agent LLM with strong prompts can achieve almost the same performance as the best existing discussion approach on a wide range of reasoning tasks and backbone LLMs' and 'multi-agent discussion performs better than a single agent only when there is no demonstration in the prompt.' Corroborated by 'Position: Stop Overvaluing Multi-Agent Debate' (OpenReview) and 'The Cost of Consensus' (ACM 2025). Votes: claim [11] 3-0, claim [13] 3-0, claim [14] 3-0.

### [7] HIGH · vote=3-0
**Claim**: Errors and hallucinations propagate and amplify through multi-agent collaboration channels: a single agent's hallucination gets spread and reinforced by other agents, turning minor inaccuracies into cascading critical failures. The two identified amplification drivers are (1) LLM overconfidence — persistently asserting correctness despite inaccuracies — and (2) inter-agent misunderstandings during collaboration.

**Sources**: https://arxiv.org/html/2501.06322v1

**Evidence**: Tran et al. 2025 survey, Section 6.1/6.3 verbatim: 'A single agent's hallucination can be spread and reinforced by other agents, leading to minor inaccuracies into critical and cascading effects' and 'There are two key factors behind this amplification: LLM overconfidence problem, where LLMs persistently assert the correctness of their outputs despite inaccuracies (Zhang et al., 2024c), and misunderstandings that arise between LLM-based agents during collaboration.' Corroborated within the same survey by MetaGPT 'amplified hallucinations' and Wang et al. 2024a. Vote: 3-0.

---
## 被对抗投票 Refuted
- **vote=0-3**: Multi-agent debate measurably improves both reasoning (mathematical and strategic) and factual accuracy versus a single model, specifically reducing hallucinations and fallacious answers that contemporary models produce. [https://arxiv.org/abs/2305.14325]
- **vote=0-2**: Model heterogeneity (mixing different underlying models in the debate, i.e. cross-vendor / cross-model debate) is a 'universal antidote' that consistently improves current MAD frameworks, rather than hurting them. [https://arxiv.org/abs/2502.08788]
- **vote=0-3**: Multi-round debate between multiple LLM instances measurably improves factuality and reasoning over single-agent baselines (Du et al. 2023; Liang et al. 2024; Xiong et al. 2023). [https://arxiv.org/html/2501.06322v1]
- **vote=1-2**: The canonical convergence pattern for adversarial debate is a third-party judge/manager agent that two debaters cooperate with: debaters compete with each other while each simultaneously cooperates with the judge, who reaches the final decision (Liang et al. 2024). [https://arxiv.org/html/2501.06322v1]

---
## Caveats
1. Domain mismatch: nearly all cited evidence is on math/factual QA (GSM8K, trivia, harmlessness preference) where answers are comparable tokens. HAPI's scenario — open-ended software design / position documents — is a different domain; majority-voting convergence (AutoGen's default) does not apply, and no cited study directly validates debate for design-deliberation tasks. Generalization is inferential.

2. 6 of the original claims could not be verified due to infrastructure errors (verifier agents errored, not refuted). Several overlap semantically with confirmed claims (sycophancy collapse, hallucination amplification, sparse-topology cost savings, MAD-not-beating-baselines) and are backstopped by the confirmed versions, but the specific quantitative framings (e.g. '40%+ input token savings from sparse topology', '5 MAD methods × 9 benchmarks systematic eval') did not get independent verification — treat those numbers as illustrative, not nailed down.

3. Cross-vendor diversity evidence [6] is thin: ONE task (Anthropic-HH harmlessness), ONE model pair (GPT-3.5 + Mistral 7B), ~1.2pp delta with overlapping error bars; on the helpfulness split the 'stronger' model is actually weaker, so the dynamic is task-dependent. Generalization to Claude + Kimi + Codex is plausible but not directly tested. The paper's own Limitations flag narrow model scope.

4. Refuted in adversarial voting: (a) the broad claim that 'multi-round debate measurably improves factuality and reasoning over single-agent' (0-3); (b) that 'cross-vendor heterogeneity is a universal antidote that consistently helps' (0-2). Both directions are contested — positive effects exist only under specific conditions (deliberate topology, tuned hyperparameters, no sycophancy amplification).

5. Source-labeling caveat: claim [11] cited the Tran survey URL as primary when it is actually secondary; the primary source (Wang et al. arXiv:2402.18272) was retrieved during verification and does support the substance. No claim's truth changed as a result.

6. Time-sensitivity: most-cited evidence is 2024-2025 (Du 2023, Smit ICML 2024, Li EMNLP 2024, Tran 2025, Yao 2025). The field is active — adaptive-stopping, judge-stability, and convergence-aware protocols are under live research as of mid-2026. Survey-based claims (Tran 2025) may age faster than primary-research claims.

---
## Open Questions
- For open-ended design/position documents (the HAPI scenario), what convergence mechanism should the manager use? Cited frameworks rely on majority voting (AutoGen) or fixed-round answer-sharing (Du et al.) — neither applies to non-comparable prose outputs. No cited study validates an LLM-judge merge step for design deliberation; this is the highest-leverage open design question.
- Is there empirical evidence on multi-agent debate effectiveness specifically for software-design / requirement-deliberation tasks (vs math/factual QA)? The entire verified evidence base is QA-style; design tasks may have different failure modes (e.g. aesthetic preference collapse rather than factual sycophancy).
- How does the manager/judge agent's own model choice affect judge-driven sycophancy? Yao et al. identify judge-driven collapse as a distinct mode but the verified claims do not pin down whether a stronger/weaker/different-vendor judge mitigates or amplifies it — directly relevant to picking HAPI's 'neutral manager' model.
- What is the cost-quality Pareto frontier for a 2-3 agent debate vs a single strong agent with reflection/self-critique, in real engineering workflows? Smit et al. show default MAD doesn't beat single-agent baselines, but no verified study maps the trade-off for the small-agent-count, long-document regime HAPI targets (most MAD studies use 3-6 agents on short-answer tasks).

## 未验证 (Unverified)
- A multi-agent system (MAS) with suboptimally-designed competitive/debate collaboration channels can be outperformed by a single-agent with strong prompts on reasoning tasks — i.e. debate-style MAS is not always better than one strong model.
- Running multiple LLM instances through a fixed number of debate rounds measurably improves factuality and reasoning — this is the canonical positive evidence for fixed-round debate protocols (citing Du et al. 'Improving Factuality and Reasoning via Multiagent Debate', Liang et al. MAD, and Xiong et al. FORD).
- Hallucinations propagate and amplify in MAS — a single agent's hallucination gets spread and reinforced by other agents, turning minor inaccuracies into cascading critical failures, with LLM 'overconfidence' (persistently asserting correctness despite being wrong) as a key driver of amplification.
- Multi-agent debate (MAD) frequently fails to beat simple single-agent baselines like Chain-of-Thought and Self-Consistency, despite consuming significantly more inference-time computation; across a systematic evaluation of 5 representative MAD methods on 9 benchmarks with 4 foundational models, MAD did not consistently outperform these baselines.
- Inter-agent sycophancy causes multi-agent debates to collapse into premature consensus before reaching a correct conclusion, making sycophancy a core failure mode of multi-agent debating systems (MADS).
- Sparse (neighbor-connected) multi-agent debate topology matches or exceeds fully-connected topology on accuracy while cutting input token cost by 40%+, because fully-connected MAD suffers premature convergence where agents lock onto the same answer and stop changing their minds.

---
## 来源清单
- [primary] https://arxiv.org/abs/2305.14325
- [primary] https://arxiv.org/pdf/2501.06322
- [primary] https://arxiv.org/abs/2502.08788
- [primary] https://arxiv.org/abs/2509.23055
- [primary] https://aclanthology.org/2024.findings-emnlp.427.pdf
- [primary] https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/multi-agent-debate.html
- [blog] https://www.digitalapplied.com/blog/multi-agent-orchestration-5-patterns-that-work
- [primary] https://arxiv.org/html/2501.06322v1
- [primary] https://proceedings.mlr.press/v235/smit24a.html
- [primary] https://arxiv.org/html/2509.05396v2
- [primary] openreview.net/forum?id=hkBM5QkFVg
- [primary] https://arxiv.org/html/2505.11556v2
- [primary] https://arxiv.org/abs/2603.04421
- [primary] https://openreview.net/pdf?id=tMJvb9JDsd
- [primary] https://www.together.ai/blog/together-moa
- [primary] https://aclanthology.org/2025.findings-acl.1141.pdf
- [primary] https://openreview.net/forum?id=Vusd1Hw2D9
- [primary] ieeexplore.ieee.org/abstract/document/11402348/
- [primary] https://arxiv.org/html/2509.23055v1
- [blog] https://aiworkshack.com/tools/autogen/debugging-autogen-group-chat-why-your-agents-loop-over-spend-and-ignore-each-oth.html
- [blog] https://medium.com/data-science-in-your-pocket/multi-agent-conversation-debates-using-langgraph-and-langchain-9f4bf711d8ab
- [primary] https://microsoft.github.io/autogen/stable//user-guide/core-user-guide/design-patterns/group-chat.html