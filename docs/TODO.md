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

---

## 4. 统一配置面（default system prompt 等不要散落）

**现状：** 默认 system / agent instructions、skill 路径、workspace 默认值、模型 baseURL/model、policy allow-list、compaction 预算等散落在代码常量、`agent.config.json`、环境变量与工厂函数参数里（例如 `coding-agent` 的 `runtime-factory.ts`、harness adapter 默认 instructions、各包自己的 config）。

**目标：** 把「可调行为」收敛到**一份（或按包一份、同构 schema 的）统一配置文件**，代码只读配置；避免改默认人设/工具白名单时满仓库搜字符串。

**建议覆盖（至少）：**

| 类别 | 示例 |
| --- | --- |
| Agent 人设 | default system / instructions、skill 路径与 loadMode |
| 模型 | provider、baseURL、model、key 环境变量名 |
| 工作区 / 工具 | default workspace、allowedTools、read/write 上限、run_tests 白名单 |
| 运行控制 | maxTurns、compaction 预算、HITL 开关、runs 目录 |
| 策略 / 计价 | maxCostUsd、pricing、redactions |

**落地注意：** 配置是数据、策略仍走现有 `Policy` / factory 注入；先从 `@agent/coding-agent` 收拢，再考虑 runtime demo 是否共用同一加载器。
