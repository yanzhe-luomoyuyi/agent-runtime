# @agent/harness

一个**模型驱动的 Agent harness**：模型每 turn 决定做什么（调用工具，或给出答案），harness 围绕它运行循环——校验工具调用、从失败中恢复、管理上下文、协调更丰富的控制流。

它是**运行时无关的**。只依赖 [`@agent/contracts`](../agent-contracts)（消息、工具规格、以及 `ChatModel` / `ToolInvoker` 接口），完全不关心宿主如何运行它。普通宿主直接调用 `runAgent`；持久化宿主（[`durable-agent-runtime`](../durable-agent-runtime)）在其幂等的 `ctx.callModel` / `ctx.callTool` 上实现同样的契约，让每个 turn 变得可重放。

> 对比运行时的 demo *工作流*（`analyze -> locate -> propose`），后者的控制流是代码里写死的。而这里是**模型**驱动；harness 是围绕它的平台。

## 四层架构（A / B / C / D）

| 层 | 目录 | 做什么 |
| --- | --- | --- |
| **A** — 工具调用协议 | `src/protocol`, `src/schema` | 把 `ChatResponse` 解释成已校验的工具调用或最终答案。参数在执行**前**按各工具的 `inputSchema` 校验；非法调用变成结构化错误而非崩溃。内置一个为不支持原生 tool-calling 的模型准备的容错文本解析器（`parseTextToolCall`、`extractJsonObject`）。 |
| **B** — 恢复 / 自愈 | `src/recovery` | 只对**瞬时性**模型/工具失败执行退避重试（`withRetry`），支持 HTTP 状态码分类（429 / 5xx / 超时）→ 结构化 `TransientError` / `HttpError`，遵循 `Retry-After` 头 + 指数退避 + full jitter。**熔断器** `CircuitBreaker`（closed→open→half_open，只对 transient error 跳闸）。**分级模型链** `createResilientModel` 按 tier 顺序尝试模型（每 tier 独立 retry+breaker），包含 escalation ladder（retry→降级→…），作为普通 `ChatModel` 零侵入。**Saga 补偿** `CompensatingToolInvoker`（opt-in 装饰器，LIFO 回滚已提交副作用，best-effort / stopOnError）。把工具抛出的异常转化为模型能理解的 observation；检测无进展的重复调用死循环（`LoopDetector`），不仅检测单次重复调用，还能检测重复序列模式（A→B→A→B），支持按工具维度的调用次数上限。 |
| **C** — 上下文 / 记忆 | `src/context` | 在 token 预算内组装 prompt + 滚动压缩（保留 system + 近期消息，其余压缩为摘要），observation 截断，重要性加权淘汰（工具错误 > 写入 > 读取），缓存友好排序；**untrusted 输出隔离**——工具结果被隔离标记为“仅数据”，被污染的结果无法劫持 agent。**可插拔 tokenizer**（默认 `cjkAwareTokenizer`：CJK ≈ 1 token/字、其余 ≈ 4 字/token，`fromCounter` 可接 tiktoken），**按模型窗口**（`ContextManager.forModel` + 型号注册表）。**主动压缩** `compactIfNeeded`：跨过预算阈值时把旧消息折叠成一条 **keyed LLM 摘要**（durable replay 安全，默认关闭、opt-in）。**Scratchpad** `ScratchpadToolInvoker`：超大工具输出自动卸载到外部存储，窗口只留指针 + 预览，模型可 `scratchpad_read` 取回（比截断不丢数据）。 |
| **D** — 控制流 | `src/control` | 核心 `runAgent` 循环 + `runAgentStreamed`（async generator，13 种类型化事件，`chatStream` 可用时实时流式输出，否则透明 fallback batch）。**工具并行执行**（`toolConcurrency` 控制并发度，`Promise.allSettled` 一个失败不影响其他）。**工具使用行为控制**（`ToolSpec.stopOnUse` 工具直接返回输出省一次 LLM 调用）。**Structured output**（`outputSchema` + 自动重试，校验失败反馈给模型自我纠正）。**可插拔错误处理器**（`errorHandlers`：`maxTurns` / `modelRefusal` / `invalidFinalOutput`）。加上 `runPlannedAgent`（先规划后执行，失败时重新规划，每步有 ✓/→/○ 进度标记）、`runReflectiveAgent`（自我批评并修订，每次尝试有独立 key 命名空间 `a0:` / `a1:` …）、`makeSubagentTool`（把子任务委派封装成一个工具，嵌套 key 全局唯一），以及 human-in-the-loop 的 `Approver`（基于模式匹配的审批门控 `deploy*`、`write*`，带过期时间的审批缓存 + 审计时间戳），`countingApprover` 包一层即可统计"人工介入率"（`requested`/`approved`/`denied`），供宿主的 eval 层读取。 |

### 可观测性

| 模块 | 做什么 |
| --- | --- |
| [tracing/collector.ts](src/tracing/collector.ts) | 结构化的 per-run 指标：token 用量统计、成本估算、每 turn 耗时、retry 次数、A/B 对比。`TraceCollector` 在循环的关键埋点处挂载，loop 通过 `hooks` / 直接调用驱动。可配置定价模型。 |

#### Trace 数据结构

```
AgentTrace                    ← 一次 run 的完整可观测指标
├── runDurationMs             ← 总耗时
├── totalTurns                ← 总轮次
├── totalRetries              ← 模型调用重试总次数
├── totalToolCalls            ← 工具调用总数
├── toolOk / toolFail         ← 工具成功 / 失败数
├── toolSuccessRate           ← 工具成功率（0–1）
│
├── 经济指标:
│   ├── totalPromptTokens
│   ├── totalCompletionTokens
│   ├── totalCachedPromptTokens     ← 服务端缓存命中的 token 数
│   ├── estimatedCostUsd            ← 费用估算
│   └── pricingModel                ← 使用的定价模型
│
└── turns: TurnTrace[]
    └── per turn:
        ├── turn
        ├── model: ModelCallTrace
        │   ├── retries / ok / durationMs / error
        │   └── usage?: { promptTokens, completionTokens, cachedPromptTokens, costUsd }
        └── tools: ToolCallTrace[]
            ├── tool / args / ok / durationMs / error
```

## 缝与持久化

两个契约方法都携带幂等 `key`：

```ts
model.chat({ messages, tools, key })      // key = `${prefix}t${turn}`
tools.call(name, args, { key })           // key = `${prefix}t${turn}:${callId}`
```

harness 以确定性方式生成这些 key。持久化宿主将每个 `key` 映射到其事件日志的 call id，所以恢复时已完成的 turn 从日志重放，不会重新触发副作用。子 Agent 扩展 `keyPrefix`（如 `t1:p1:t1:s1`），保证嵌套下 key 全局唯一。

## 目录结构

```
src/
  schema/validate.ts        # A: 极简 JSON-Schema 参数校验器
  protocol/tool-calling.ts  # A: 响应 → 已校验调用 | 最终答案
  context/manager.ts        # C: token 预算、压缩（含 keyed 模型摘要）、untrusted 围栏
  context/tokenizer.ts      # C: 可插拔 token 计数（默认 CJK-aware）
  context/model-limits.ts   # C: 按模型窗口注册表 + forModel
  context/scratchpad.ts     # C: 超大输出卸载（filesystem-as-context）
  context/tool-augment.ts   # C: 通用 ToolInvoker 装饰器（给非 durable host 加本地工具）
  recovery/retry.ts         # B: 瞬时失败重试 + 退避 + HTTP 分类
  recovery/loop-detector.ts # B: 无进展检测（含序列检测 A→B→A→B）
  recovery/circuit-breaker.ts # B: 熔断器（closed→open→half_open 三态）
  recovery/fallback.ts      # B: 分级模型链（fallback + escalation ladder）
  recovery/compensation.ts  # B: Saga 补偿（opt-in 装饰器，LIFO 回滚）
  control/loop.ts           # D: 核心 agentic 循环（组合 A/B/C/D）
  control/planner.ts        # D: 先规划后执行
  control/reflection.ts     # D: 自我批评并修订
  control/subagent.ts       # D: 子任务委派封装为工具
  control/human.ts          # D: 审批接入点
  tracing/collector.ts      # 结构化 trace：token / 成本 / 决策
  testkit/index.ts          # 确定性的 ChatModel / ToolInvoker 替身
  demo.ts                   # 3 场景离线 demo：happy path + resilient model + saga compensation
```

## 使用

```bash
# 从仓库根目录
npm install                 # 将 @agent/contracts link 到本包
npm run build               # 先构建 @agent/contracts，再构建 @agent/harness
npm test                    # 先构建 contracts，再在这里跑 vitest

# 只操作本包
npm test -w @agent/harness
npm run dev -w @agent/harness   # 运行离线 demo (tsx src/demo.ts)
```

### 最小示例

```ts
import { runAgent } from '@agent/harness';
import { MockToolInvoker, RuleChatModel, makeTool, toolCall, toolCallResponse, finalResponse } from '@agent/harness/testkit';

const tools = new MockToolInvoker([
  makeTool('searchCode', 'search', { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    () => ({ files: ['src/auth/login.ts'] })),
]);

const model = new RuleChatModel((req) => {
  const done = req.messages.some((m) => m.role === 'tool');
  return done
    ? finalResponse('Guard the null session in src/auth/login.ts.')
    : toolCallResponse([toolCall('c1', 'searchCode', { query: 'login null session' })]);
});

const res = await runAgent({ goal: 'Login crashes on a null session', model, tools });
console.log(res.answer, res.toolsUsed);
```

### 使用 TraceCollector

```ts
import { runAgent, TraceCollector, estimateCost } from '@agent/harness';

const trace = new TraceCollector();
const res = await runAgent({
  goal: 'Fix the login bug',
  model,
  tools,
  hooks: {
    onModelCall: (call) => trace.recordModelCall(call),
    onToolCall: (call) => trace.recordToolCall(call),
    onTurnComplete: (turn) => trace.recordTurn(turn),
    onAgentComplete: (result) => trace.finalize(result),
  },
});
console.log(trace.summary());
// { turns: 3, modelCalls: 3, toolCalls: 2, totalTokens: 4500, estimatedCostUsd: 0.023, ... }
```

### Structured output

```ts
import { runAgent } from '@agent/harness';

// 要求模型返回结构化 JSON
const res = await runAgent({
  goal: 'Extract the user name and email',
  model,
  tools,
  outputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      email: { type: 'string' },
    },
    required: ['name', 'email'],
  },
  outputRetries: 2,  // 校验失败时最多重试 2 次（默认 3 次）
});

// 如果模型返回的 JSON 不符合 schema，校验错误会反馈给它自我纠正
// 重试耗尽后触发 errorHandlers.invalidFinalOutput（如果设置了的话）
console.log(res.answer); // 干净的 JSON（自动去掉 markdown fence）
```

### Streaming（流式运行）

```ts
import { runAgentStreamed, type AgentStreamEvent } from '@agent/harness';

// 流式运行 — 实时获得模型 token、工具调用进度等事件
for await (const event of runAgentStreamed({ goal: 'Fix the login bug', model, tools })) {
  switch (event.type) {
    case 'model_token':
      process.stdout.write(event.token);  // 像打字一样逐字输出
      break;
    case 'tool_start':
      console.log(`\n🔧 Calling ${event.name}...`);
      break;
    case 'tool_done':
      console.log(`✅ ${event.name}: ${event.ok ? 'OK' : 'FAILED'}`);
      break;
    case 'done':
      console.log(`\nFinal answer: ${event.result.answer}`);
      break;
  }
}
```

> 如果模型实现了 `chatStream`，工具 token 和 tool calls 会随着模型生成实时产生。否则自动回退到 batch `chat()` 并重建事件 —— 同样的 API，透明的 fallback。

### 使用 Lifecycle Hooks（9 个钩子）

```ts
import { runAgent } from '@agent/harness';

const res = await runAgent({
  goal: 'Fix the bug',
  model,
  tools,
  hooks: {
    onAgentStart: (goal) => console.log('Starting:', goal),
    onAgentEnd:   (res)  => console.log('Done:', res.stopReason),
    onTurnStart:  (t)    => console.log('Turn', t),
    onTurnEnd:    (t)    => console.log('Turn', t, 'done'),
    onModelStart: (t)    => console.log('Calling LLM...'),
    onModelEnd:   (t, u) => console.log('LLM done.', u.completionTokens, 'tokens'),
    onModelError: (t, e) => console.error('LLM failed:', e),
    onModelResponse: (t, m) => { /* full assistant message */ },
    onToolStart:  (t, id, name) => console.log('Tool:', name),
    onToolResult: (t, name, obs, ok) => console.log(ok ? '✅' : '❌', name),
    onValidationRetry: (t, errors) => console.log('Retry:', errors),
  },
});
```

### 工具并行 + 行为控制 + 错误处理

```ts
import { runAgent, createAgent } from '@agent/harness';

// stopOnUse: 搜索工具的原始输出直接作为答案，省一次 LLM 调用
const searchTool = {
  name: 'search',
  description: '搜索知识库',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  stopOnUse: true,  // ← 新功能
};

const res = await runAgent({
  goal: 'What is the capital of France?',
  model,
  tools,
  toolConcurrency: 3,  // ← 新：同 turn 内最多 3 个工具并行
  errorHandlers: {      // ← 新：可插拔终止处理器
    maxTurns: (ctx) => ({
      answer: 'Unable to complete within turn budget.',
      finished: false,
      stopReason: 'max_turns',
      turns: ctx.turns,
      messages: ctx.messages,
      toolsUsed: [],
      durationMs: 0,
    }),
    modelRefusal: (ctx) => ({
      answer: `Model refused: ${ctx.refusal}. Please rephrase your request.`,
      finished: false,
      stopReason: 'model_refusal',
      turns: ctx.turns,
      messages: ctx.messages,
      toolsUsed: [],
      durationMs: 0,
    }),
  },
});
```

## 在持久化运行时上运行（下一步）

集成方式是一个薄适配器（位于运行时的 `app/` 层中），通过将调用委托给 `ctx.callModel` / `ctx.callTool` 并透传 `key` 来实现 `ChatModel` + `ToolInvoker` 契约。harness 代码无需任何改动——这正是将其放在 `@agent/contracts` 抽象之后、保持运行时无关性的意义所在。

启用方式：在 durable-agent-runtime 中设置 `HARNESS=1` 环境变量：

```bash
HARNESS=1 npm run dev -- run "Login page crashes with a null session"
```

这会使用 `harness-adapter.ts` 将完整的 A/B/C/D 四层 agent 循环封装为单个 durable workflow step，享受事件溯源、崩溃恢复、幂等重放等全部平台能力。
