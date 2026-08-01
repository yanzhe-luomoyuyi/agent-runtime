# Observability：Harness Trace · Runtime Trace · Eval

本文说明仓库里**两套 trace**和 **eval 模块**各自包含什么、从哪来、怎么用。它们不是同一条管道，也不互相替代。

| 层 | 模块 | 一句话 |
|----|------|--------|
| Harness | `@agent/harness` → `tracing/collector.ts` | 跑 agent loop 时**现场写入**内存：turn / tool args / 上下文装配决策 |
| Runtime | `durable-agent-runtime` → `trace.ts` (+ `otel.ts`) | 从 **event log 事后派生** span 时间线：phase/step、replay、policy、缓存省钱 |
| Eval | `durable-agent-runtime` → `eval.ts` | 对真实 run 的 `RunState` + **runtime** `Trace` 做可组合打分，出 pass/fail 报告 |

---

## 1. 为什么是两套 trace

```
┌─────────────────────────────┐
│  agent-harness (大脑)        │
│  TraceCollector  ← 现场埋点  │  「这一轮模型/工具/上下文怎么决策」
└──────────────┬──────────────┘
               │ ChatModel / ToolInvoker 契约（可选挂 durable host）
┌──────────────▼──────────────┐
│  durable-agent-runtime      │
│  event log → buildTrace()   │  「这次 durable run 怎么执行/重放」
│  otel.ts → Jaeger / Tempo…  │
└─────────────────────────────┘
```

- Harness 保持 **host-agnostic**：不碰网络、不读事件日志。
- Runtime 的 trace **没有独立 telemetry 管道**：只要有日志就能重建（含 resume / 失败 run）。
- 挂 durable host 时两边可并存，**不会自动合并**成一条；需要对照时由宿主自己关联 `runId` / turn。

---

## 2. agent-harness：`TraceCollector` / `AgentTrace`

**源码：** `agent-harness/src/tracing/collector.ts`  
**上下文决策类型：** `AssembleDecision` / `CompactDecision`（`context/manager.ts`）

### 2.1 怎么取出来

```ts
import { runAgent, TraceCollector, formatTraceReport, DEFAULT_PRICING } from '@agent/harness';

const collector = new TraceCollector(DEFAULT_PRICING['gpt-4o'], 'gpt-4o');
const res = await runAgent({ goal, model, tools, trace: collector });
const trace = collector.snapshot(res.durationMs);  // → AgentTrace
console.log(formatTraceReport(trace));
```

- Collector **由调用方持有**；`AgentRunResult` 本身不含完整 trace（只有 `durationMs` 等）。
- 未传 `trace` 时 loop 不打点，零开销。

### 2.2 Run 级字段（`AgentTrace`）

| 字段 | 含义 |
|------|------|
| `runDurationMs` | 整次 run 墙钟（通常来自 `res.durationMs`） |
| `totalTurns` | 记录到的 turn 数 |
| `totalRetries` | 模型调用重试总次数 |
| `totalToolCalls` / `toolOk` / `toolFail` / `toolSuccessRate` | 工具调用汇总 |
| `totalPromptTokens` / `totalCompletionTokens` / `totalCachedPromptTokens` | Token 合计（来自成功 model call 的 usage） |
| `estimatedCostUsd` | 按 `pricingModel` 估算的费用 |
| `pricingModel` | 本 run 使用的单价表 |
| `turns` | 每 turn 明细（见下） |

辅助：`formatTraceReport(trace)` 人类可读；`compareTraces(a, b)` 做 A/B 百分比对比（turns / retries / tools / cost / duration）。

### 2.3 Turn 级字段（`TurnTrace`）

每个 turn 一条：

| 块 | 内容 |
|----|------|
| `model` | `ok`、`durationMs`、`retries`、`error?`、`usage?`（prompt / completion / **cachedPromptTokens** / `costUsd`） |
| `tools[]` | 每个工具：`tool`、`args`、`ok`、`durationMs`、`error?` |
| `context?` | 本 turn 模型调用**之前**的上下文决策（见下） |

### 2.4 上下文决策（`TurnTrace.context`）

Loop 在 `_prepareTurn` 里调用 `compactIfNeededDetailed` + `assembleDetailed`，再 `recordCompact` / `recordAssemble`；在 `endModelCall` 时挂到该 turn。

**`AssembleDecision`（同步硬顶装配）**

| 字段 | 含义 |
|------|------|
| `outcome` | `passthrough`（未超预算）/ `assembled`（发生压缩装配） |
| `inputTokens` / `outputTokens` / `availableBudget` | 装配前后 token 与可用预算 |
| `keptMessages` / `summarizedMessages` |  verbatim 保留 vs 折进摘要 |
| `hardCapEvictedMessages` | 因 hard-cap trim 被丢掉的条数（摘要的子集） |
| `pinnedUnits` / `grownUnitsAdmitted` | 近期 pin 的 unit 数 / 折扣扩窗收进来的 unit 数 |
| `hardCapTrimmed` / `importanceScoring` | 是否触发硬裁、是否开了重要性 |
| `reasons` | 标签，如 `under_budget`、`pinned_recent`、`hard_cap_trim`、`heuristic_summary` |

**`CompactDecision`（可选 LLM 主动压缩）**

| 字段 | 含义 |
|------|------|
| `outcome` | `noop` / `compacted` |
| `reason` | `no_summarizer` / `under_threshold` / `nothing_to_fold` / `no_budget` / `compacted` |
| `inputTokens` / `outputTokens` | 压缩前后 |
| `protectedUnits` / `summarizedMessages` | `protectVerbatimClasses` 名单内留下的 unit 数 / 折进 LLM 摘要的条数 |
| `key?` | durable 摘要 key（如 `compact-t3`） |

### 2.5 Harness trace **没有**什么

- 不感知 phase / step / event log / resume  
- 不统计 policy denial、replay hit rate、内容缓存省钱（那是 runtime）  
- 不自动导出 OTel（导出在 runtime `otel.ts`）

---

## 3. durable-agent-runtime：`buildTrace` / `Trace`

**源码：** `durable-agent-runtime/src/trace.ts`  
**导出：** `otel.ts` 把同一份 `Trace` 桥成 OpenTelemetry span（可选 OTLP）

### 3.1 怎么取出来

```ts
const state = await runtime.run(issue);
const trace = runtime.trace(state.runId);   // 内部：读 event log → buildTrace(events)
console.log(renderTimeline(trace));
```

任意时刻只要有该 `runId` 的日志，就能重建（completed / failed / 中途 resume 均可）。

### 3.2 Run 级字段（`Trace`）

| 字段 | 含义 |
|------|------|
| `runId` | 运行 id |
| `startedAtMs` | 首事件 epoch-ms；span 的 `startMs` 相对此锚点 |
| `spans` | 嵌套时间线（见下） |
| `totals` | 汇总指标（见下） |
| `byPhase` | 按 phase 的 model token / cost 分解 |

### 3.3 Span（`Span`）

| `kind` | 典型 `name` | 说明 |
|--------|-------------|------|
| `run` | `run` | 整次 run |
| `phase` | `phase:<name>` | 工作流阶段 |
| `step` | `step:<stepId>` | 步骤 |
| `tool` | `tool:<toolName>` | 工具调用；`error` 标记失败；attributes 含 tool name / call id |
| `model` | `model` | 模型调用；attributes 含 prompt/completion/cached_prompt tokens、cost |

每个 span：`startMs`（相对 run 起点）、`durationMs`、`depth`（缩进层级）。

### 3.4 Totals（`TraceTotals`）

| 字段 | 含义 |
|------|------|
| `wallMs` / `modelMs` / `toolMs` | 墙钟 / 模型耗时合计 / 工具耗时合计 |
| `promptTokens` / `completionTokens` / `costUsd` | 来自 `ModelCalled` 事件 |
| `modelCalls` / `toolCalls` / `failedToolCalls` | 调用计数 |
| `policyDenials` | 策略层拒绝次数（`PolicyDenied`） |
| `replayedCalls` / `replayHitRate` | resume 时从日志重放而未重执行的调用占比 |
| `cachedModelCalls` / `cachedPromptTokens` / `costSavedUsd` | Provider prompt-cache 命中调用数 / hit tokens / 相对 miss 价估算省下的钱 |

> `HumanIntervention`（steer / abort）是 observability-only 事件：写入日志供审计，**不**进入 `TraceTotals` 计数；与 `PolicyDenied` 一样不改派生态 `RunState`。

`renderTimeline(trace)` 打印缩进时间线 + totals / replay / cache / policy / by-phase。

### 3.5 Runtime trace **没有**什么

- 不包含 harness 的 **assemble / compact 决策**（那些只在 `TraceCollector` 里）  
- 不按「agent turn」组织（按 phase / step / callId）  
- 不含模型返回的 tool **arguments** 决策明细（harness `ToolCallTrace.args` 才有）

### 3.6 与 OTel 的关系

`otel.ts` 消费 **runtime** `Trace`，重建 run→phase→step→tool/model 父子 span，并用历史时间戳导出。未配置 `OTEL_EXPORTER_OTLP_ENDPOINT` 时退回 console。这是 host 侧 IO，故不放进 harness。

---

## 4. durable-agent-runtime：Eval 模块设计

**源码：** `durable-agent-runtime/src/eval.ts`

### 4.1 设计原则

1. **Eval 是真实 run 的投影，不是旁路。** Scorer 只读 `RunState` + **runtime** `Trace`（与生产同一套 durable 产物）。  
2. **可组合检查。** 每个 `Scorer` 只判一个性质，场景用 `checks: Scorer[]` 拼装。  
3. **CI 友好。** 配确定性 mock model 时可无网回归；LLM-judge 通过注入 `ModelProvider`，可换成启发式 stand-in。  
4. **Harness 场景显式开关。** 需要 turns / 工具序列 / 人工审批统计时，场景设 `harness: true` 或提供 `approver`。

### 4.2 核心类型

```
Scenario { name, issue, checks[], policy?, harness?, approver? }
    │
    ▼ runEval(scenarios, buildRuntime)
    │  每场景：临时目录 → Runtime → run(issue) → runtime.trace(runId)
    │         → 跑全部 Scorer({ state, trace })
    ▼
EvalReport { results[], passed, failed, total, allPassed }
```

| 类型 | 作用 |
|------|------|
| `ScoreContext` | `{ state: RunState, trace: Trace }` — scorer 唯一输入 |
| `CheckResult` | `{ name, passed, detail? }` |
| `Scorer` | `(ctx) => CheckResult \| Promise<CheckResult>` |
| `Scenario` | 名称、输入 issue、checks；可选 policy / harness / approver |
| `ScenarioResult` / `EvalReport` | 单场景与整次评测结果 |
| `runEval` / `renderReport` | 执行与打印 |

`buildRuntime(baseDir, scenario)` 由调用方注入：决定用哪套 model/tools/policy，以及是否走 harness 适配器。

### 4.3 内置 Scorer 一览

#### 结果 / 状态

| Scorer | 读什么 | 断言 |
|--------|--------|------|
| `runCompleted()` | `state.status` | 必须 `completed` |
| `runFailedWith(substr)` | `state.status` + `state.error` | 失败且错误信息含 substr（如 budget） |
| `proposalContains(substr)` | `state.summary.proposal` | 提案文本包含子串 |
| `touchedFile(path)` | `state.summary.files` | 触达文件列表含 path |

#### 成本 / 可靠性（读 **runtime** `trace.totals`）

| Scorer | 断言 |
|--------|------|
| `costUnderUsd(max)` | `costUsd ≤ max` |
| `noToolFailures()` | `failedToolCalls === 0` |
| `toolSuccessRate(min)` | 成功工具占比 ≥ min（0–1） |

#### Harness 过程指标（读 `state.summary`）

| Scorer | 断言 | 备注 |
|--------|------|------|
| `turnsUnder(max)` | `summary.turns ≤ max` | 非 harness run 会 fail（无 turns） |
| `trajectoryJudge(judge, criterion)` | 工具序列被 judge PASS | 读 `summary.toolsUsed` |
| `llmJudge(judge, criterion)` | 最终提案被 judge PASS | 读 proposal |

#### 人工审批（读 `countingApprover` 的 `ApprovalStats`）

| Scorer | 断言 |
|--------|------|
| `humanInterventionsUnder(stats, max)` | 审批请求次数 ≤ max |
| `humanInterventionRequested(stats, min)` | 至少触发 min 次（防闸门被静默绕过） |

场景带 `approver` 时隐含 `harness: true`。

> Mid-run `RunInterrupter` / `HumanIntervention` 事件目前**没有**对应 eval scorer——介入审计走事件日志；工具级介入率仍读 `ApprovalStats`。

#### Policy / 护栏（读 `trace.totals.policyDenials`）

| Scorer | 断言 |
|--------|------|
| `noPolicyViolations()` | denial == 0 |
| `policyDenied(min)` | denial ≥ min（护栏回归：确认会拦） |

场景可设 `policy` 覆盖，专测 guardrail。

#### Judge 替身（CI）

| 对象 | 行为 |
|------|------|
| `heuristicJudge` | 提案需同时「点出具体修复」+「引用源文件」才 PASS |
| `heuristicTrajectoryJudge` | `getIssue` 在 `searchCode` 前，且无连续重复同一工具 |

生产可换成真实 `ModelProvider`；文档约定低温度 / 结构化输出 / 多数票缓解非确定性。

### 4.4 与两套 Trace 的关系

```
runEval
  → runtime.run()
  → runtime.trace(runId)     ← 只用 durable-agent-runtime Trace
  → Scorer({ state, trace })

Harness TraceCollector  ← 默认不进 eval
```

当前内置 scorer **不读取** harness 的 `AssembleDecision` / `CompactDecision`。适配层**已支持** `createHarnessWorkflow({ trace })` 挂上 `TraceCollector`（coding-agent Workbench Trace 页即 runtime `buildTrace` + harness snapshot 并排展示）。若要对上下文策略做 **eval 回归**，还可以：

1. 把 `AgentTrace` 写入 `state.summary` 或旁路文件，供 scorer 读取；或  
2. 新增读 summary 字段的 scorer（与现有 `turnsUnder` 模式一致）。

Ablation 级对比（pure-recency vs importance+pin）目前在 harness 单测 `test/context-ablation.test.ts`，尚未并入 `runEval`。

### 4.6 外部宿主接入示例：coding-agent 的 eval

**源码：** `coding-agent/src/eval/{fixtures,scenarios,runtime}.ts`，CLI 命令 `coding-agent eval`。

`eval.ts` 的整套打分器 + `runEval`/`renderReport` 现从 `durable-agent-runtime/src/index.ts` 导出（此前只有本包 demo CLI 在用，未对外暴露）。coding-agent 是第一个外部消费者，接入时踩了一个值得记录的坑，并补了一个内置库没有的打分器：

- **`touchedFile()` 对 coding-agent 不适用**：该 scorer 读 `state.summary.files`，这个字段只有本包 demo 工作流的假工具会填（返回 `{ files: [...] }`）。coding-agent 真实的 `write_file`/`str_replace` 返回的是 `{ path }`，不是 `{ files }`，所以 `touchedFile` 对它会静默永远不匹配。coding-agent 另写了 `editedFile(path)`，直接读工具**调用参数**里的 `path`（`state.stepOutputs['agent.1'].messages[].toolCalls[].arguments.path`），而不是工具返回结果。
- **新增 `testsPass()` 打分器（客观标准，不在平台内置库里）**：读 transcript 里最后一次 `run_tests` 工具结果，解析其 `{ ok, exitCode }`，只有真的 `ok === true` 才算过——防止模型嘴上说"修好了"但代码没真改对，比字符串匹配最终答案（`proposalContains`）硬得多。
- **场景库是真实、零依赖的 bug fixture**，不是假数据：`BugCase`（`srcPath`/`buggySrc`/`fix.{oldString,newString}`/`testPath`/`testSrc`）在临时目录写一个真实会跑的 Node 脚本（`node:assert/strict`，无需 `node_modules`），改之前 `npm test` 必挂、改之后必过——这正是 SWE-bench 那套"repo 快照 + 任务 + 可执行验证器"范式的缩微零依赖版。
- **CI 用脚本化模型**（`ScriptedChatProvider`），不接真实模型——这套 eval 防的是"框架接线/config 改坏了"（Runtime/Policy/Scratchpad 组装回归），不是"模型到底会不会修 bug"；后者需要接真实模型（见 `AGENT_EVAL_REGRESS=1` 之外，另立一个"live 能力回归"档位，本仓库目前尚未做，是有意识地延后）。

```bash
npm run dev -w @agent/coding-agent -- eval                      # 脚本化模型，全过
AGENT_EVAL_REGRESS=1 npm run dev -w @agent/coding-agent -- eval # 演示回归被抓住
```

### 4.5 典型用法骨架

```ts
import {
  runEval, renderReport,
  runCompleted, costUnderUsd, noToolFailures, turnsUnder,
  llmJudge, heuristicJudge, trajectoryJudge, heuristicTrajectoryJudge,
} from './eval.js';

const report = await runEval(
  [
    {
      name: 'login-null-session',
      issue: 'Login crashes on null session',
      harness: true,
      checks: [
        runCompleted(),
        costUnderUsd(0.05),
        noToolFailures(),
        turnsUnder(8),
        llmJudge(heuristicJudge, 'Names a concrete fix and cites a file'),
        trajectoryJudge(heuristicTrajectoryJudge, 'Fetches issue before searching code'),
      ],
    },
  ],
  (baseDir, scenario) => buildMyRuntime(baseDir, scenario),
);

console.log(renderReport(report));
process.exit(report.allPassed ? 0 : 1);
```

---

## 5. 对照速查

| 问题 | 看哪里 |
|------|--------|
| 这 turn 为什么裁掉了旧消息？最新 user 还在吗？ | Harness `turn.context.assemble` |
| 有没有做 LLM compact？key 是什么？ | Harness `turn.context.compact` |
| 模型这次调了哪个工具、参数是什么？ | Harness `turn.tools[].args` |
| Resume 省了多少次真实调用？ | Runtime `totals.replayHitRate` |
| Policy 拦了几次？内容缓存省了多少钱？ | Runtime `policyDenials` / `costSavedUsd` |
| 哪个 phase 最烧 token？ | Runtime `byPhase` |
| CI 里提案/轨迹/成本是否回归？ | Eval `runEval` + scorers（读 runtime Trace + RunState） |
| 导出到 Jaeger？ | Runtime `otel.ts`（不经 harness） |

---

## 6. 相关源码

| 路径 | 内容 |
|------|------|
| `agent-harness/src/tracing/collector.ts` | `TraceCollector`、`AgentTrace`、`formatTraceReport`、`compareTraces` |
| `agent-harness/src/context/manager.ts` | `AssembleDecision`、`CompactDecision`、`assembleDetailed`、`compactIfNeededDetailed` |
| `agent-harness/src/control/loop.ts` | `_prepareTurn` 写入 assemble/compact；model/tool 埋点 |
| `agent-harness/test/context-ablation.test.ts` | 上下文策略 ablation（非 eval） |
| `durable-agent-runtime/src/trace.ts` | `buildTrace`、`renderTimeline` |
| `durable-agent-runtime/src/otel.ts` | OTel 导出 |
| `durable-agent-runtime/src/eval.ts` | Scenario / Scorer / `runEval` |
| `durable-agent-runtime/test/eval.test.ts` | Eval 回归测试 |
