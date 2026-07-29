# Backlog / TODO

未实现或待加强的方向，按主题记录。实现前先对一下现有可插拔面与 HITL 能力，避免重复造轮子。

---

## 1. 可插拔策略的对照评测（ablation / eval cases）

**现状：** Context manager、tokenizer、压缩、retrieval 注入、approver、error handler 等多处已可插拔；部分对照已在 harness 单测（如 `context-ablation.test.ts`），但尚未系统化进 runtime `runEval`。

**目标：** 建一批专门衡量「同一任务、不同策略」差异的 evaluation case，而不是只测 happy path。

**可先覆盖的维度（示例）：**

| 维度 | 候选策略 | 关心的指标 |
| --- | --- | --- |
| 上下文淘汰 / pin | pure-recency vs importance+pin vs 更激进压缩 | 任务成功率、turns、token、是否丢关键指令 |
| Tokenizer / 预算 | 默认 CJK-aware vs 固定 counter | 装配稳定性、截断行为 |
| 主动压缩 | 关 / 开 / 不同频率与 verbatim 保护 | 摘要质量、重放安全、成本 |
| Retrieval | `once` / `once_rewrite` / `capped_agentic` | 命中相关性、额外模型调用、护栏是否仍成立 |
| Approver | auto vs pattern gate vs counting | 介入率、误拦、任务是否完成 |

**落地建议：** 场景固定（goal + tools + mock/真模型），只换注入的策略实现；打分用现有 eval scorers（结果 + 过程 + 成本），必要时加「策略标签」字段方便横向对比。

---

## 2. 统一配置面（default system prompt 等不要散落） — **已完成（coding-agent）**

**现状（落地后）：** `@agent/coding-agent` 的可调行为收敛到包根 `agent.config.json`，由 `src/config.ts` 加载（defaults ← 文件 ← env）；`runtime-factory` / CLI / Workbench 只读配置。策略实现仍走现有 `Policy` / factory 注入。

**覆盖：**

| 类别 | 配置键 |
| --- | --- |
| Agent 人设 | `agent.instructions` / `skillPath` / `skillLoadMode` |
| 模型 | `model.baseUrl` / `model` / `apiKeyEnv*`（env 覆盖） |
| 工作区 / 工具 | `workspace.defaultRoot`、`tools.*`、`policy.allowedTools` |
| 运行控制 | `run.maxTurns` / `runsDir` / `autoApproveWrites` / `compaction` |
| 计价 | `pricing` / `policy.maxCostUsd` |

**未做：** durable-agent-runtime demo 与 coding-agent 共用同一加载器（仍可按包各一份同构 schema 演进）。

---

## 3. coding-agent Workbench：Session / crash / resume / pause / HITL

**现状：** UI 能开单次 `run`、看 SSE 进度与 Trace；CLI 已有 `resume` / `status` / `trace`。harness / runtime 侧已有 `RunInterrupter`、`HumanIntervention`、`crashAfterTurn`、durable resume，但 **Workbench 未暴露**。

**目标：** 在 UI 上接上会话与运维控制面：

| 能力 | 说明 |
| --- | --- |
| **Session** | 多轮对话 / 会话列表与当前 session 绑定（延续 `conversationHistory` 或 runtime session API） |
| **主动 crash** | 注入 / 触发 crash（对齐 `crashAfterTurn` 或「立即失败」），用于验证 durable resume |
| **Resume** | 对已有 `runId` 一键 resume，展示与新建 run 相同的进度 / Trace |
| **Pause** | turn 边界暂停（`RunInterrupter` pause），UI 显示 paused 并可继续 |
| **人工介入** | steer / abort /（写工具）approval：UI 表单注入，写入 `HumanIntervention` / approver 路径 |

**落地注意：** SSE 协议扩展 `paused` / `needs_input` 等事件；busy 锁改为 per-run；与 §2 统一配置里的 HITL 开关对齐。

