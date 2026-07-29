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

---

## 5. EventLog 乐观并发写入改为可选项

**现状：** `durable-agent-runtime` 的 `EventLog.append` 默认按版本做乐观并发（多文件 / 冲突检测，`ConflictError`）；单机单 worker 调试时一个 run 目录下会散落大量序号 JSON。

**目标：** 把「乐观并发多文件写入」做成 **Runtime / EventLog 可选项**：

| 模式 | 行为 |
| --- | --- |
| 开（默认，现行为） | 按 version 乐观写入；适合多 worker / 并发 append |
| 关 | **一个 `runId` 对应单个（或极少）日志文件**（例如整 log append-only 单文件，或关闭 CAS 的简化布局），降低本地调试噪音、方便肉眼翻 run 目录 |

**落地注意：** 关模式下仍需保证 resume 可读完整事件序；snapshot 与 `ConflictError` 路径要明确「单写者」假设；在 `docs/runtime-caching-and-policy.md` / cheatsheet 里写清何时开/关。

---

## 6. coding-agent Workbench：Session / crash / resume / pause / HITL

**现状：** UI 能开单次 `run`、看 SSE 进度与 Trace；CLI 已有 `resume` / `status` / `trace`。harness / runtime 侧已有 `RunInterrupter`、`HumanIntervention`、`crashAfterTurn`、durable resume，但 **Workbench 未暴露**。

**目标：** 在 UI 上接上会话与运维控制面：

| 能力 | 说明 |
| --- | --- |
| **Session** | 多轮对话 / 会话列表与当前 session 绑定（延续 `conversationHistory` 或 runtime session API） |
| **主动 crash** | 注入 / 触发 crash（对齐 `crashAfterTurn` 或「立即失败」），用于验证 durable resume |
| **Resume** | 对已有 `runId` 一键 resume，展示与新建 run 相同的进度 / Trace |
| **Pause** | turn 边界暂停（`RunInterrupter` pause），UI 显示 paused 并可继续 |
| **人工介入** | steer / abort /（写工具）approval：UI 表单注入，写入 `HumanIntervention` / approver 路径 |

**落地注意：** SSE 协议扩展 `paused` / `needs_input` 等事件；busy 锁改为 per-run；与 §4 统一配置里的 HITL 开关对齐。

---

## 7. coding-agent UI：手动调整 max prompt tokens

**现状：** `maxPromptTokens = min(modelWindow, softCap)`，softCap 默认 128k，可由 `AGENT_MAX_PROMPT_TOKENS` / 环境决定；UI 只读展示 model 与预算。

**目标：** Workbench 上提供 **可编辑的 max prompt tokens**（滑条或输入框），对本 run / 本 session 生效，并与 Trace Overview 的 assemble/compact 行为对齐。

**落地注意：** 校验范围（例如 ≥ 输出 reserve、≤ model window）；是否写回 `.env` / 仅内存覆盖要产品上二选一；改预算后正在跑的 run 不热更新（下一 run 生效即可）。
