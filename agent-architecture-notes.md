# Agent Architecture — Implementation Review

> 面试复习用。对比本项目实现 vs 工业界最前沿做法。只记要点。

---

## 一、Protocol 层（Response 解析 + Argument 校验）

### 本项目的实现

```
agent-contracts → Message / ChatResponse / ToolCall 类型
agent-harness/protocol/tool-calling.ts → interpretResponse() + parseTextToolCall()
agent-harness/schema/validate.ts → 轻量 JSON Schema validator
```

**核心决策类型：**
```typescript
ProtocolDecision =
  | { kind: 'final';      answer: string;  thinking?: string }
  | { kind: 'tool_calls'; calls: PreparedCall[]; thinking?: string; aside?: string }
```

**设计要点：**
- 二元模型（tool_calls | final）——源自 OpenAI/Anthropic 原生 tool-calling API
- `PreparedCall` 在 interpret 阶段就完成 schema 校验，坏的 call 变成结构化 error 喂回模型，不抛异常
- 支持 native tool-calling + text-only fallback（`parseTextToolCall` 容忍地从自由文本提取 JSON）
- `aside` 保留 tool-call 同时返回的文字旁白（Anthropic multi-block 模式）
- `thinking` 保留推理链（o1/Claude Extended Thinking/DeepSeek-R1）
- Schema validator 刻意不做完整 JSON Schema（无 $ref/oneOf），只覆盖 tool input 需要的子集，零依赖

### 工业界对照

| 框架 | Response 类型 | 特点 |
|------|--------------|------|
| **OpenAI Responses API**（最新，替代 Chat Completions） | `message` / `tool_call` / `reasoning` / `computer_call` / `file_search_call` | 内置 tool-calling loop；reasoning 是一等公民 |
| **Anthropic Claude** | `text` / `tool_use` / `thinking` content blocks | Extended Thinking 有签名（防篡改）；多 block 共存 |
| **Vercel AI SDK v5** | 多 part message：`text` / `tool-call` / `reasoning` / `file` | 一个 turn 可同时包含 text + tool-call + reasoning，不互斥 |
| **LangChain** | `AgentAction`(tool/tool_input/log) / `AgentFinish`(return_values/log) | 本质也是二元，但 AgentAction 带 log（推理日志） |
| **LangGraph** | StateGraph node → `Command` 路由 | 不区分 tool/final，都是状态转移；支持 `interrupt()` 挂起等人工 |
| **AutoGen 0.4+** | `TextMessage` / `ToolCallRequestMessage` / `ToolCallExecutionMessage` / `HandoffMessage` / `StopMessage` | Handoff 是第一公民（agent 间委托）；多 agent 对话建模 |
| **Google ADK / A2A** | `text` / `tool_call` / `code_execution` / `agent_transfer` | agent_transfer 是内置类型；A2A 有 `needs-input` 等待状态 |
| **Smolagents (HF)** | Code Agent / Tool-calling Agent 两种模式 | code as action — 代码执行被当作一种独立的 action 类型 |

### 关键差异 & 可扩展点

1. **Reasoning/Thinking** → 已支持 ✅（`thinking` 字段）
2. **Text + ToolCall 共存** → 已支持 ✅（`aside` 字段）
3. **Agent Handoff** → 通过 subagent tool 实现（`delegate`），非独立 decision 类型。若需 Swarm 风格 transfer，需 runtime 层 detect 返回值
4. **Code Execution** → 可建模为 tool call，无需新 decision 类型
5. **Streaming** → 不支持。需要完全不同的执行模型（async iterator），属于 provider 特性而非 protocol 特性
6. **Structured Output** → 未做。final answer 可以带 schema 约束做 validate，场景有限

### 面试要点速记

- "Protocol 层职责单一：把 model response 变成 loop 可执行的 decision，validate 前置，坏 call 不抛异常而是变 observation"
- "二元模型是正确的基础抽象——从 RL 角度 agent 每步只有 act 或 stop"
- "Thinking 必须在 transcript 中保留并喂回下一轮，否则模型失忆"
- "Anthropic 的 thinking 是 signed 的——需要原样保存，不能篡改"
- "Handoff 和 subagent 的区别：subagent 是 call-and-return，handoff 是 transfer-and-forget"

---

## 二、Recovery 层（容错、降级、回滚）

> 详见 [agent-harness/src/recovery/](agent-harness/src/recovery/)。

### 本项目实现概览

| 模块 | 文件 | 职责 |
|------|------|------|
| 瞬时重试 | `retry.ts` | 指数退避 + full-jitter，分层错误分类 (HTTP status→type→regex)，服务端 `Retry-After` / `X-RateLimit-Reset` 优先 |
| 循环检测 | `loop-detector.ts` | 滑动窗口 + 序列模式 (A→B→A→B) + per-tool limits |
| 熔断器 | `circuit-breaker.ts` | closed→open→half_open 三态；`isFailure` 只对 transient error 计数跳闸 |
| 分级模型链 | `fallback.ts` | `withRetry(circuitBreaker(model.chat))` 按 tier 顺序尝试，包含 escalation ladder (retry→降级→…)，作为普通 `ChatModel` 零侵入 |
| Saga 补偿 | `compensation.ts` | opt-in `ToolInvoker` 装饰器，LIFO 回滚，best-effort / stopOnError 两种模式 |

### 工业界 Recovery 的做法分级

#### A. 传输/API 层 — 标准弹性模式（源自 Netflix OSS / AWS / Polly）

| 做法 | 本项目 | 说明 |
|------|--------|------|
| **指数退避 + Full Jitter** | ✅ `withRetry` | 防 thundering-herd；AWS 推荐 full jitter（非 equal/decorrelated） |
| **分层错误分类** | ✅ HTTP status → `type` 字段 → regex | 避免纯字符串匹配；OpenAI/Anthropic 错误格式 ( `{"error":{"type":"..."}}` ) 原生支持 |
| **尊重 Retry-After / RateLimit-Reset** | ✅ | server hint 优先于本地 backoff，上限 60s |
| **Circuit Breaker（熔断器）** | ✅ | Nygard 经典三态；仅 transient error 计为 failure；半开单探针 |
| **Hedged Requests（对冲请求）** | ❌ | 慢尾延迟时并发发第二个请求取先返回者（gRPC/Tailscale 做法） |
| **Provider/Model Fallback（降级）** | ✅ `createResilientModel` | 多 tier 链式尝试，每 tier 独立 retry+breaker；同一 key 透传保证 durable replay 确定性 |
| **Token-bucket 客户端限流** | ❌ | 主动限速防 429，比被动响应更优雅 |
| **Idempotency-Key 透传** | 🟡 | 有 durable key，但未透传到 provider 侧 `Idempotency-Key` header |

#### B. Agentic 循环层 — LLM native 的自恢复（2024–2025 最活跃）

| 做法 | 本项目 | 说明 |
|------|--------|------|
| **Loop / No-progress 检测** | ✅ 滑动窗口 + 序列模式 | 非连续重复不误触发；A→B→A→B 循环可检测；per-tool limits |
| **工具错误 → Observation 模型自恢复** | ✅ `executeCall` 从不抛 | 参数非法/被拒/工具抛错/loop 命中全部转 observation 喂回 |
| **Reflection / Self-critique（Reflexion）** | ✅ `reflection.ts` | critic model 判定→追加 feedback 重跑，独立 key 命名空间 |
| **错误感知的结构化修复引导** | 🟡 | 当前回传 error 文本，未附带 schema/示例/上次参数差异 |
| **Progress/Stall Detection 超越签名匹配** | ❌ | 用"状态变化率/目标距离"判断进展（LangGraph/AutoGPT 新方向） |
| **Escalation Ladder（升级阶梯）** | ✅ `createResilientModel` | retry → 换 tier → ...；链尾可选 human-backed model 实现 HITL |
| **Saga / Compensation（补偿回滚）** | ✅ `CompensatingToolInvoker` | opt-in 装饰器，LIFO 逆序回滚；best-effort 收集所有错误，stopOnError 立即中断 |
| **Checkpoint-and-Rewind** | 🟡 | 有 snapshot 用于 resume，但不用于 loop 内 "回退到上一步重试"（LangGraph `checkpointer` 时间旅行） |

#### C. 持久化/编排层 — Durable Execution（Temporal/Restate/DBOS 范式，2024–2025 大热）

| 做法 | 本项目 | 说明 |
|------|--------|------|
| **Event Sourcing + Replay** | ✅ `eventlog.ts` + `reducer.ts` | state 永远从 log 重新推导，天然 resumable |
| **Snapshot 加速 Resume** | ✅ `snapshot.ts` | 只重放 tail；tmp+rename 原子写防 torn write |
| **乐观并发（单写者）** | ✅ `wx` 独占写 + ConflictError | OS 文件系统即 CAS，无锁跨进程 |
| **Activity Heartbeat + Timeout** | ❌ | 长任务心跳检测卡死并重启 |
| **Dead-Letter Queue（死信）** | ❌ | 反复失败的任务进 DLQ 人工介入 |
| **Poison-Message 检测** | ❌ | 某输入总让 worker 崩溃时隔离 |
| **Exactly-Once 副作用** | 🟡 | 有 deterministic key 方案，但需确认 provider 侧幂等 |

#### D. 可观测/治理层

| 做法 | 本项目 | 说明 |
|------|--------|------|
| 结构化 Trace + Retry 计数 | ✅ `TraceCollector` | token 用量/成本/每 turn 耗时/retry 次数 |
| Retry Budget（运行级熔断） | ✅ `retryBudget` | 整个 run 的模型调用重试上限 |
| Cost/Token Budget 熔断 | 🟡 | durable 侧有 spend 追踪，harness loop 未做预算熔断 |
| Anomaly/Drift 告警 | ❌ | 重试率/loop 率突增触发告警 |

### 面试要点速记

- "Retry 不够——需要 Circuit Breaker 防止对已挂服务持续打压，需要 Fallback 保证可用性，需要 Saga 回滚已提交副作用"
- "熔断器三态：closed → (failures ≥ N) → open → (timeout) → half_open → (probe succeeds) → closed"
- "Escalation ladder = retry → degrade → ... → HITL，每 tier 独立 retry+breaker"
- "整个 resilient model 是普通 ChatModel，零侵入 loop——durable replay 的 key 透传不变"
- "Saga 不能进核心 loop：loop 的哲学是'错误→observation→自愈'，回滚语义是业务层逻辑，做成 opt-in 装饰器"
- "CompensatingToolInvoker：只记录成功调用，只回滚注册过补偿器的工具，LIFO 逆序"

---

## 三、Context 层（上下文工程 / 记忆）

> 2025 年被 Karpathy 命名为 **context engineering**，取代 prompt engineering。核心命题：在有限窗口里，用最少 token 装进最相关信息（Anthropic 称对抗 **context rot**）。
> harness 的 C 层：[agent-harness/src/context/](agent-harness/src/context/)；跨会话记忆：[durable-agent-runtime/src/memory/](durable-agent-runtime/src/memory/)。

### 本项目实现概览

| 模块 | 位置 | 职责 |
|------|------|------|
| 预算 + 硬顶装配 | harness `manager.ts` | `maxPromptTokens` 减去 output/tool 预留；system 在前、动态在后（cache 友好）；goal 保护；重要性加权淘汰 + 硬顶裁剪 |
| CJK-aware tokenizer | harness `tokenizer.ts` | CJK ≈ 1 token/字、其余 ≈ 4 字/token（消除 length/4 对中日韩 ~4× 低估）；`fromCounter` 可接 tiktoken |
| 按模型窗口 | harness `model-limits.ts` | 最长前缀匹配模型→窗口；`ContextManager.forModel(name)` |
| 主动压缩（模型摘要） | harness `manager.ts` `compactIfNeeded` | 跨阈值→把旧消息折叠成一条 **keyed LLM 摘要**；有状态（压一次固化）；durable replay 靠 key 复用不重算 |
| Untrusted 隔离 | harness `manager.ts` | 工具输出围栏成"data only"，绝不并入 system（prompt-injection 防御） |
| Scratchpad | harness `scratchpad.ts` | 超大工具输出自动卸载到外部存储，窗口只留指针+预览，可 `scratchpad_read` 取回（比截断不丢数据） |
| 跨会话记忆 | **runtime** `memory/store.ts` | 持久、分 scope、内容哈希幂等写；读写走 `ctx.callTool` 被记日志 → replay 确定 |

### 工业界做法分级

#### A. Token 预算 / 窗口
| 做法 | 本项目 | 说明 |
|---|---|---|
| 硬顶 + output/tool 预留 | ✅ | 上下文窗口是物理硬限，不是软建议 |
| 精确 tokenizer | 🟡 | 默认 CJK-aware 启发式（零依赖）；`fromCounter` 可换 tiktoken |
| 按模型自动切窗口 | ✅ `forModel` | 128K/200K/1M 注册表，最长前缀匹配 |
| 多模态 token 计量 | ❌ | 图像/音频 token 未计 |

#### B. 压缩 / 摘要
| 做法 | 本项目 | 说明 |
|---|---|---|
| 近期逐字 + 旧的截断 | ✅ | assemble 硬顶兜底 |
| 模型驱动摘要 | ✅ `compactIfNeeded` | 走 keyed `callModel`，durable-safe |
| 自动压缩阈值 | ✅ `compactionThreshold` | 默认 0.85 触发，留下一 turn 余量 |
| 有状态（压一次固化） | ✅ | 替换历史，后续不重算 |
| 结构化交接（不摘要） | ❌ | Cognition 的固定 schema 传递（更抗信息丢失） |
| 递归摘要（summary-of-summaries） | 🟡 | 旧摘要目前累积、不再折叠（长跑缓慢增长） |

#### C. 记忆系统（2024–2025 最活跃）
| 做法 | 本项目 | 说明 |
|---|---|---|
| Working memory（run 内） | ✅ | 压缩 + scratchpad |
| **跨会话持久记忆** | ✅ runtime | 手动版：`memory_write/search/read` 工具 + 分 scope FileMemoryStore |
| 虚拟上下文 / 分页（MemGPT/Letta） | 🟡 | scratchpad = 平民版分页；无自动换入换出控制器 |
| 记忆抽取 + 反思（Mem0） | ❌ | 手动写，无自动提炼（高危、留人工闸门） |
| 时序知识图谱（Zep/Graphiti） | ❌ | 无图/实体消解 |
| 情景/语义/程序性分层 | 🟡 | store 有 `kind` 字段；程序性记忆=只读 skills（未做自更新） |
| 文件系统即记忆（Manus） | ✅ scratchpad | 长内容落盘、窗口留指针 |

#### D. 检索 / 选择
| 做法 | 本项目 | 说明 |
|---|---|---|
| 重要性评分（规则） | ✅ | tool error > write > read；指数折扣 |
| 近期性 | ✅ | |
| 词法检索（memory_search） | ✅ | 零依赖确定性打分（含 CJK） |
| 语义 / embedding 检索 | ❌ | seam 已留（换 store/retriever 子类即可）；刻意不进 assemble |
| Just-in-time agentic retrieval | 🟡 | 记忆是 JIT（模型自己 search）；通用 RAG 工具已 revert（应属应用层） |

#### E. Prompt 缓存
| 做法 | 本项目 | 说明 |
|---|---|---|
| 静态前缀 + 动态后缀排序 | ✅ | OpenAI 自动前缀缓存直接受益 |
| KV-cache 稳定性（确定性摘要） | 🟡 | 摘要走 keyed 调用、确定 |
| 显式 Anthropic cache breakpoints | ❌ | 无真 provider，暂缓（该在 provider adapter 内做） |

#### F. 安全 / 隔离
| 做法 | 本项目 | 说明 |
|---|---|---|
| Untrusted 工具输出围栏 | ✅ **强于多数框架** | spotlighting/delimiting |
| 摘要区不泄露 untrusted | ✅ | 摘要 prompt 也加围栏 |
| 记忆 scope 强制隔离 | ✅ | 一 scope 一文件 + 路径消毒（防跨用户泄漏/穿越） |
| PII 脱敏后入窗 | 🟡 | runtime policy 层有 redact，context 层未做 |

### 架构决策：什么归 harness、什么归 runtime

判据一句话：**操作 transcript → harness；跨 run 持久化 → runtime。**

- **harness（C 层）**：只操作 transcript（tokenizer、压缩、scratchpad、untrusted 围栏、装配）。无状态、per-run、只依赖 `@agent/contracts`。
- **runtime**：跨会话记忆（持久化 + 跨 run 确定性是 runtime 的核心领域）。harness 里的 in-memory 记忆是 toy（进程一死就没）→ 已下沉到 runtime。
- **ToolInvoker 两类**：**行为装饰器**（Scratchpad/Compensating/Augment，只依赖契约）→ harness；**宿主桥接器**（RuntimeToolInvoker，把契约实现到 `ctx.callTool`）→ 必须 runtime。
- **确定性 footgun**：记忆读必须走 `ctx.callTool` 被记日志，否则 replay 时读到已变的 store 会发散。装饰器本地 dispatch 会绕过日志——所以记忆做成 registry 工具（走桥接器），不做成 Augment 本地工具。

---
## 四、Loop 层（Agent 循环引擎）

> harness 的 D 层：[agent-harness/src/control/loop.ts](agent-harness/src/control/loop.ts)

### 本项目的实现

**架构：** `LoopState` 捆绑全部可变状态；`_prepareTurn` / `_callModelBatch` / `_handleResponse` / `_executeTools` 为共享 helper；`runAgent`（batch）和 `runAgentStreamed`（async generator）是薄入口。两个入口共享所有决策逻辑和工具执行，只在事件上报方式上不同（noop callback vs `yield`）。

**loop 的核心结构：**
```
每个 turn:
  1. _prepareTurn: compaction → assemble prompt
  2. model call (batch retry / streaming)
  3. _handleResponse: refusal detect → final answer + structured output validate → or tool_calls
  4. _executeTools: approval + loop detect + execute (串行/并行) → observations
  5. 检查 stop conditions (tripped / max_turns / crashAfterTurn)
```

**关键能力速览：**
- **Tool 并行**：`toolConcurrency`，`Promise.allSettled`，单失败不影响其他
- **Tool use behavior**：`ToolSpec.stopOnUse` → 工具输出直接作为 final answer
- **Structured output**：`outputSchema` + 自动重试（错误 feed back 给模型）
- **Error handlers**：`maxTurns` / `modelRefusal` / `invalidFinalOutput` 可插拔
- **Streaming**：`runAgentStreamed` async generator，13 种类型化事件；`chatStream` 可用时实时流式，否则 batch fallback
- **9 Lifecycle hooks**：`onAgentStart/End`、`onTurnStart/End`、`onModelStart/End/Error`、`onModelResponse`、`onToolStart/Result`、`onValidationRetry`
- **Durable key 方案**：`t{turn}` 给 model、`t{turn}:{callId}` 给 tool；keyPrefix 扩展支持子 agent 嵌套

### 工业界 Loop 实现对比

| 框架 | Loop 类型 | 核心特点 |
|------|----------|---------|
| **OpenAI Agents SDK** | 简单 while | LLM→output/handoff/tool_calls→execute→repeat。支持 `tool_use_behavior`（run_llm_again / stop_on_first_tool）、`toolConcurrency`、guardrails、error_handlers、Sessions |
| **LangChain `createAgent`** | Middleware 管道 | 核心 loop 薄，所有行为通过 middleware stack 注入（SummarizationMiddleware / FilesystemMiddleware / SubAgentMiddleware / HumanInTheLoopMiddleware / PIIMiddleware / RetryMiddleware） |
| **LangGraph** | StateGraph (Pregel) | 非 while 循环——每个 turn 是图的节点；LangGraph Cloud 支持 durable execution、streaming、interrupt、time-travel |
| **Anthropic Claude** | API 原生 | 无框架；tool_use blocks + stop_reason；caller 自己写 loop；server-side tools（web_search/code_execution）由 Anthropic 托管 |
| **Vercel AI SDK v5** | `generateText` / `streamText` | 内置 maxSteps loop；streaming + tool calling 作为一等公民；多 provider 统一接口 |
| **AutoGen 0.4+** | 异步消息传递 | agent = actor；handoff 是消息路由而非嵌套调用；支持 group chat（多 agent 共享上下文） |
| **Smolagents (HF)** | Code Agent | 模型输出可执行代码而非 tool call JSON；运行时在 sandbox 中执行 |

### 本项目的独特优势（面试高亮）

1. **Loop 检测优于所有主流框架**：滑动窗口 + 序列模式检测（A→B→A→B）+ per-tool 调用上限。OpenAI 仅靠 `reset_tool_choice` 防无限循环，LangChain 无内置序列检测。
2. **Saga 补偿**：`CompensatingToolInvoker`，LIFO 回滚已提交副作用。业界罕见——多数框架不支持"撤销已执行的工具"。
3. **熔断器 + 分级模型降级链**：`CircuitBreaker` 三态 + `createResilientModel` escalation ladder。作为普通 `ChatModel` 零侵入。
4. **Untrusted 输出隔离**：工具结果围栏标记，"被污染的输出无法劫持 agent"。Anthropic 有类似关注但无框架级实现。
5. **确定性 Key 方案**：`t{turn}` / `t{turn}:{callId}` + keyPrefix 嵌套 —— 整个 durable replay 契约只需要一个 string。
6. **Shared helpers 架构**：`runAgent` 和 `runAgentStreamed` 共享所有决策逻辑（`_handleResponse` / `_executeTools`），各 ~35 行入口。避免双份实现。

### 关键差距（诚实版）

| 差距 | 状态 | 说明 |
|------|------|------|
| **Middleware 管道** | ❌ 计划中 | 当前所有横切行为（retry/loop detect/approval/validation）硬编码在共享 helper 里，非独立可插拔模块 |
| **原生 tool-calling streaming** | 🟡 | `chatStream` 接口已定义，但 streaming 路径缺少 `withRetry` 保护。真实的 OpenAI/Anthropic adapter 需要实现 `chatStream` |
| **Tool 执行与模型输出的重叠** | ❌ | Streaming 下 tool call 仍是"等模型全部说完再执行"，不如 OpenAI SDK 的边生成边执行 |
| **子 Agent 并行** | ❌ | `makeSubagentTool` 是同步顺序委派。LangGraph/DeepAgents 的 subagent 可并行 |
| **Prompt Caching** | 🟡 | ContextManager 做 cache-friendly 排序，但未对接 API 层（缺少 Anthropic cache breakpoint 标记） |
| **Structured Output 原生对接** | 🟡 | Post-hoc validate + retry；未利用 OpenAI `response_format` / Anthropic `tool_choice` 的原生能力 |

### 面试要点速记

- "Loop 的本质：model 决策 → execute → observation → 再决策，直到 model 说 stop 或 budget 耗尽"
- "batch vs streaming 的区别不是'有没有实时 token'，而是 tool 能否在模型还没说完时就开始执行。目前我们的 streaming 只做了前者。"
- "Tool 并行执行时不需要考虑依赖——同一 turn 内的 tool calls 语义独立，模型被训练为正确处理。依赖跨 turn 自然处理。"
- "Durable replay 的 key 是整个系统的契约：harness 生成 key → adapter 透传 → runtime 用 key 做 idempotency cache → crash 后 resume 时 cache hit 不重执行"
- "Middleware pipeline 是下一步方向：当前 shared helpers 已经是内部模块化，开放成可插拔接口就是 middleware"
- "Loop 检测的序列模式是真正区分'模型在探索'和'模型在死循环'的关键——只看单次重复会有大量假阳性"
- "相比 OpenAI Agents SDK 的极简 while、LangGraph 的 DAG 节点，我们的 loop 是中等复杂度：够用但不冗余"
