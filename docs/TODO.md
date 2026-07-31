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
| Tokenizer / 预算 | 默认 tiktoken vs CJK-aware vs 固定 counter | 装配稳定性、截断行为、与 provider usage 偏差 |
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

## 3. coding-agent Workbench：Session / crash / resume / pause / HITL — **已完成**

**现状（落地后）：** Workbench 暴露会话与运维控制面；SSE 扩展 `paused` / `needs_input` / `crashed` / `intervention` / `session`；busy 改为 per-run registry（`workbench-runs.ts`）。

| 能力 | 落地 |
| --- | --- |
| **Session** | `SessionManager` 导出；`GET/DELETE /api/sessions`、`POST /api/sessions/:id/continue`；新 run 自动建 session |
| **主动 crash** | Run 表单 `crashAfterTurn`；SSE `crashed` + Resume 按钮 |
| **Resume** | `POST /api/runs/:runId/resume`（与新建 run 同 SSE）；列表中 running 可一键 resume |
| **Pause** | `POST .../pause|continue|steer|abort` + `RunInterrupter`；SSE `paused` |
| **人工介入** | HITL writes 开关 → `needs_input` + `POST .../approve`；steer/abort 表单 |

**未做：** SSE 重连挂接进行中 run（`GET .../stream`）；多 run 并行 drive。

