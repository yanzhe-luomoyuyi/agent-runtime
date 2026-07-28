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

## 2. 人工随时介入（mid-run interrupt / steer） — done

**已实现：** harness `RunInterrupter` / `createInterruptHandle`（turn 边界 pause / steer / abort+salvage，`stopReason: 'aborted'`）；durable `HumanIntervention` 事件 + `StepContext.emit` + adapter `interrupter` 包装入日志。

---

## 3. Planner：plan 生成后的 Human Review — done

**已实现：** `PlanReviewer`（`approve` / `edit` / `reject`+可选 remake）；`runPlannedAgent({ planReviewer, reviewReplans })` 在首次 plan 与 replan 后过闸门。
