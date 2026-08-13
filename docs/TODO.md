# Backlog / TODO

未实现或待加强的方向，按主题记录。实现前先对一下现有可插拔面与 HITL 能力，避免重复造轮子。

---

## 1. 可插拔策略的对照评测（ablation / eval cases） — **部分完成（L2 harness）**

**现状（落地后）：** `@agent/harness` 已有 L2 eval（`src/eval/`：`runHarnessEval` + `defaultHarnessScenarios`）。覆盖 assemble importance vs recency、compact protect / noop、retrieval gate、scratchpad offload、loop 序列/advisory、工具级 HITL 等——读 `AgentTrace`，不挂 durable runtime。组件级对照仍保留在 `test/context-ablation.test.ts`。

**仍待加强：**

| 维度 | 候选策略 | 关心的指标 | 状态 |
| --- | --- | --- | --- |
| 上下文淘汰 / pin | pure-recency vs importance+pin | 是否丢关键指令 / ERROR unit | ✅ L2 assemble scenarios |
| 主动压缩 | 关 / 开 / `protectVerbatimClasses` | 保护单元、fold、re-call notice | ✅ L2 compact scenarios |
| Retrieval 注入 | minScore gate / untrusted | 低分丢弃、围栏 | ✅ L2（harness 注入层）；runtime `once`/`capped_agentic` 模式对照仍属 L3 |
| Approver | counting + requireApprovalFor | 介入率 | ✅ L2 工具级；run 级 interrupter 未进 L2 |
| Scratchpad | offload / neverOffload | 指针 vs 内联 | ✅ L2 |
| Tokenizer / 预算 | tiktoken vs CJK vs char | 装配边界 | ❌ 未系统化进 L2 |
| Runtime retrieval 模式 | `once` / `once_rewrite` / `capped_agentic` | 命中、额外模型调用 | ❌ 仍属 L3 / backlog |

**落地建议（剩余）：** tokenizer 对照与 runtime retrieval 模式 ablation 可继续用同一 Scenario/Scorer 形状；L3 `runEval` 不必重复 L2 已覆盖的 harness 决策面。

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

