# Agent Architecture — Implementation Review（完整版）

> 包含：Protocol · Recovery · Context · Loop · Tracing · Planner · HITL · Reflection · Sub-agent

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
- ✅ Streaming（`runAgentStreamed`：async generator，13 种事件类型，chatStream 实时流式 + batch fallback）
- ✅ Structured Output（`outputSchema` + auto-retry，校验失败反馈给模型自我纠正）

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

### 要点
- "二元模型是正确的基础抽象——从 RL 角度 agent 每步只有 act 或 stop"
- "Protocol 层职责单一：把 model response 变成 loop 可执行的 decision，validate 前置，坏 call 不抛异常而是变 observation"
- "Handoff 和 subagent 的区别：subagent 是 call-and-return，handoff 是 transfer-and-forget"

---

## 二、Recovery 层（容错、降级、回滚）

### 本项目实现概览

| 模块 | 文件 | 职责 |
|------|------|------|
| 瞬时重试 | `retry.ts` | 指数退避 + full-jitter，分层错误分类（HTTP status→type→regex），`Retry-After` 优先。✅ `retryBudget` 运行级熔断 |
| 循环检测 | `loop-detector.ts` | 滑动窗口 + 序列模式（A→B→A→B）+ per-tool limits |
| 熔断器 | `circuit-breaker.ts` | closed→open→half_open 三态；仅 transient error 跳闸 |
| 分级模型链 | `fallback.ts` | 按 tier 尝试（每 tier 独立 retry+breaker）+ escalation ladder，零侵入 `ChatModel` |
| Saga 补偿 | `compensation.ts` | opt-in 装饰器，LIFO 回滚，best-effort / stopOnError |

### 工业界对照

| 做法 | 本项目 | 说明 |
|------|--------|------|
| 指数退避 + Full Jitter | ✅ | AWS 推荐 |
| Circuit Breaker | ✅ | Nygard 经典三态 |
| Provider/Model Fallback | ✅ `createResilientModel` | 多 tier + escalation ladder |
| Saga / Compensation | ✅ | LIFO 回滚（业界罕见） |
| Loop 检测（序列模式） | ✅ 强于多数框架 | A→B→A→B 序列检测 |
| Hedged Requests | ❌ | 慢尾延迟并发请求 |
| Token-bucket 限流 | ❌ | 主动限速 |
| Activity Heartbeat + Timeout | ❌ | 长任务心跳 |
| Dead-Letter Queue | ❌ | 死信人工介入 |

### 要点
- "Retry 不够——需要 Circuit Breaker 防止对已挂服务持续打压，需要 Fallback 保证可用性，需要 Saga 回滚已提交副作用"
- "熔断器三态：closed → (failures ≥ N) → open → (timeout) → half_open → (probe succeeds) → closed"
- "Escalation ladder = retry → degrade → ... → HITL"
- "Saga 不能进核心 loop：loop 的哲学是'错误→observation→自愈'，回滚是 opt-in 装饰器"
- "Event Sourcing + Snapshot → 快速恢复 + 幂等重放"

---

## 三、Context 层（上下文工程 / 记忆）

> 2025 年 Karpathy 命名 context engineering。核心命题：有限窗口里，用最少 token 装进最相关信息。

### 本项目实现

| 模块 | 职责 |
|------|------|
| 预算 + 硬顶装配 | `maxPromptTokens` − output/tool 预留；system 在前（cache 友好）；goal 保护；重要性加权淘汰 + 硬顶裁剪 |
| CJK-aware tokenizer | CJK ≈ 1 token/字、其余 ≈ 4 字/token；`fromCounter` 可接 tiktoken |
| 按模型窗口 | `ContextManager.forModel(name)`，128K/200K/1M 注册表 |
| 主动压缩 | `compactIfNeeded`：keyed LLM 摘要，有状态（压一次固化），durable replay 安全 |
| Untrusted 隔离 | 工具输出围栏成"data only"，绝不并入 system（prompt-injection 防御） |
| Scratchpad | 超大工具输出卸载到外部存储，窗口留指针+预览 |
| 跨会话记忆 | **runtime** `memory/store.ts`：分 scope、内容哈希幂等写，读写走 `ctx.callTool` 被记日志 |

### 工业界对照

#### 记忆系统
| 做法 | 本项目 | 说明 |
|------|--------|------|
| Working memory（run 内） | ✅ | 压缩 + scratchpad |
| 跨会话持久记忆 | ✅ runtime | `memory_write/search/read` 工具 + FileMemoryStore |
| **MemGPT / Letta** 三层记忆 | 🟡 | Working/Episodic/Semantic，OS 式管理；scratchpad 算平民版分页 |
| **CrewAI** 记忆分离 | ❌ | 短期/长期/实体记忆 + 向量检索 |
| **Mem0** 自动提炼 | ❌ | 刻意不做——自动提炼高危，留人工闸门 |
| **Zep / Graphiti** 知识图谱 | ❌ | 时序图谱 + 实体消解 |

#### 压缩 / 摘要
| 做法 | 本项目 | 说明 |
|------|--------|------|
| 模型驱动摘要 | ✅ | keyed callModel，durable-safe |
| 自动压缩阈值 | ✅ | 0.85 触发，留一 turn 余量 |
| **LLMLingua-2 / LongLLMLingua** | ❌ | 小模型评估每条消息信息贡献度 → 按贡献裁剪，非按位置 |
| **LLM 自摘要用便宜模型** | 🟡 | 可换 GPT-4o-mini 降成本 |
| **Cognition 结构化交接** | ❌ | 固定 schema 传递，不摘要（更抗信息丢失） |

#### 检索 / Prompt 缓存
| 做法 | 本项目 | 说明 |
|------|--------|------|
| 重要性评分 | ✅ | tool error > write > read |
| 词法检索 | ✅ | 零依赖 mini-BM25（含 CJK） |
| 语义/embedding 检索 | ❌ | seam 已留 |
| 静态前缀排序 | ✅ | OpenAI 前缀缓存直接受益 |
| Anthropic cache breakpoints | ❌ | 暂缓 |

### 架构决策
- **操作 transcript → harness**（tokenizer、压缩、scratchpad、untrusted 围栏）。无状态、per-run。
- **跨 run 持久化 → runtime**。记忆读必须走 `ctx.callTool` 被记日志，否则 replay 读到已变 store。
- "Context engineering 核心矛盾：窗口有限 vs 信息无限 → 解法是信息密度最大化"
- "LLMLingua 思路：用便宜模型先评估贡献度再决定保留/丢弃——比 LRU 更聪明"

---

## 四、Loop 层（Agent 循环引擎）

### 本项目的实现

**架构：** `LoopState` 捆绑全部可变状态；`_handleResponse` / `_executeTools` 为共享 helper；`runAgent`（batch ~35 行）和 `runAgentStreamed`（async generator ~75 行）是薄入口。

**关键能力：**
- **Tool 并行**：`toolConcurrency`，`Promise.allSettled`
- **Tool use behavior**：`stopOnUse` → 工具输出直接作为 final answer
- **Structured output**：`outputSchema` + auto-retry（错误 feed back 给模型）
- **Error handlers**：`maxTurns` / `modelRefusal` / `invalidFinalOutput`
- **Streaming**：13 种类型化事件；chatStream 实时流式 + batch fallback
- **9 Lifecycle hooks**：onAgentStart/End、onTurnStart/End、onModelStart/End/Error、onModelResponse、onToolStart/Result、onValidationRetry
- **Durable key**：`t{turn}` 给 model、`t{turn}:{callId}` 给 tool

### 工业界 Loop 对比

| 框架 | Loop 类型 | 核心特点 |
|------|----------|---------|
| **OpenAI Agents SDK** | 简单 while | LLM→output/handoff/tool_calls→repeat；`tool_use_behavior`、guardrails、Sessions |
| **LangChain `createAgent`** | Middleware 管道 | 核心 loop 薄，所有行为通过 middleware stack 注入 |
| **LangGraph** | StateGraph (Pregel) | 非 while 循环——图节点；durable execution、streaming、interrupt |
| **Anthropic Claude** | API 原生 | 无框架；caller 自己写 loop；server-side tools |
| **Vercel AI SDK v5** | `generateText`/`streamText` | 内置 maxSteps loop；多 provider 统一接口 |
| **AutoGen 0.4+** | 异步消息传递 | agent = actor；handoff 是消息路由 |

### 独特优势
1. **Loop 检测**：滑动窗口 + 序列模式（A→B→A→B）——优于所有主流框架
2. **Saga 补偿**：LIFO 回滚——业界罕见
3. **熔断器 + 分级模型链**：零侵入 `ChatModel`
4. **Untrusted 隔离**：prompt-injection 防御
5. **确定性 Key 方案**：整个 durable replay 契约只需一个 string

### 关键差距
| 差距 | 状态 |
|------|------|
| Middleware 管道 | ❌ 计划中 |
| 原生 tool-calling streaming | 🟡 retry 已修复，需真实 provider adapter |
| Tool 执行与模型输出重叠 | ❌ streaming 下仍是"模型说完再执行" |
| 子 Agent 并行 | ❌ 同步顺序委派 |
| Prompt Caching API 对接 | 🟡 |
| Structured Output 原生对接 | 🟡 post-hoc，未用 API 原生能力 |

### 要点
- "Loop 本质：model 决策 → execute → observation → 再决策，直到 stop 或 budget 耗尽"
- "Tool 并行不需要考虑依赖——同 turn 内 tools 语义独立，跨 turn 自然处理"
- "Durable replay 的 key 是系统契约：harness 生成 → adapter 透传 → runtime idempotency cache"
- "Loop 检测的序列模式是区分'探索'和'死循环'的关键——单次重复有大量假阳性"

---

## 五、Tracing / Observability

### 本项目实现
- `TraceCollector`：token 用量/成本/每 turn 耗时/retry 次数
- 可配置 PricingModel（GPT-4o / Claude 等）
- `formatTraceReport()` 终端友好输出；`compareTraces()` A/B 对比
- **durable-agent-runtime 侧**：`trace.ts` 从事件日志派生 span 时间线（纯数据模型，不碰 IO）；`otel.ts` 将其桥接成真正的 OpenTelemetry span（`NodeTracerProvider` + `OTLPTraceExporter`）——未配置 collector 时退回 `ConsoleSpanExporter`离线运行，配置 `OTEL_EXPORTER_OTLP_ENDPOINT` 就发往 Jaeger/Tempo/Honeycomb 等标准后端。导出层放在 runtime 而非 harness，因为导出是真实网络 IO，harness 保持 host-agnostic。

### 工业界
| 工具 | 定位 |
|------|------|
| **LangSmith** | LangChain 官方，自动追踪 + eval 评分 |
| **Helicone** | 代理层透明拦截 LLM API |
| **OpenLLMetry** | OpenTelemetry 标准 span |
| **Braintrust** | eval-first 设计 |
| **Arize Phoenix** | 自动检测 hallucination / toxicity / prompt injection |

### 前沿：Eval 闭环 — trace → 自动打分 → 不合格标记 → 反馈改进

### 要点
- "tracing 不是事后诸葛亮，是 eval 的输入——生产 trace → 自动评分 → 回归检测"
- "OTel 导出属于运行时层，不属于 harness——因为它需要真实网络 IO，harness 只产出结构化数据"

---

## 六、Planner（规划执行）

### 本项目实现
- `PlanState`：per-step status（pending/in_progress/completed/failed）+ ✓/→/○ 进度标记
- 逐步执行：每个 step 独立 `runAgent` + 进度上下文注入 system prompt
- 失败重规划：step 失败 → 模型重新生成剩余步骤
- `validatePlanFeasibility` + Durable key namespace

### 工业界 & 前沿
| 做法 | 说明 |
|------|------|
| **ReAct** | Think→Act→Observe，你的 loop 本质即 ReAct |
| **Plan-and-Solve (2023)** | 先规划再执行 — 你的实现基本对齐 |
| **HuggingGPT / TaskMatrix** | LLM 拆任务 → 分发模型，DAG 依赖 |
| **LangGraph Send API** | 有条件分支状态图，fan-out 并行 |
| **Tree of Thoughts (ToT, 2023)** | 每步多候选，BFS/DFS 探索，投票选择 |
| **Graph of Thoughts (GoT)** | ToT 泛化，允许多思路合并 |
| **LATS (2024)** | ToT + 反思 + 记忆 |
| **OpenAI o1 (2024)** | 内部隐式 CoT + 自我验证 |

### 要点
- "Plan-and-Solve 是 ReAct 的升级——先规划再执行，失败可重规划"
- "ToT/GoT 是探索式规划：每步多条路，不是一条路走到黑"

---

## 七、Human-in-the-Loop

### 本项目实现
- `autoApprove` / `denyAll` / `requireApprovalFor`（glob：`deploy*`）
- `withApprovalCache`：时间缓存，N 分钟内同类请求自动放行
- `modifiedArgs`：人工可修改参数后批准 + `decidedAt` 审计 trail

### 工业界 & 前沿
| 做法 | 说明 |
|------|------|
| **LangGraph interrupt** | 节点暂停，等人工审批后 resume |
| **AutoGPT / CrewAI** | 简单 yes/no，无参数修改 |
| **参数级审批 UI** | 审批界面显示参数编辑表单 |
| **条件审批策略** | 基于 args 内容/历史记录动态决定 |
| **审批超时** | N 秒无响应 → 自动拒绝/降级 |

### 要点
- "HITL 不只是 yes/no——参数修改、时效缓存、glob 模式匹配，缺一不可"

---

## 八、Reflection（反思）

### 本项目实现
- pass/fail 循环：跑完 loop → 模型自评 → 不满意重来
- `maxReflections` + 独立 key 命名空间（`a0:` / `a1:`）

### 工业界 & 前沿
| 做法 | 说明 |
|------|------|
| **Reflexion (2023)** | 结构化反思：哪步出错 + 如何修正（比 pass/fail 更精细） |
| **Self-Consistency (2022)** | 同一问题跑 3-5 次，投票决定最终答案 |
| **验证工具集成** | 跑实际 test suite 而非模型自我判断 |
| **反思记忆** | 上次反思的教训跨 run 保留 |

### 要点
- "Reflexion 的核心不是'重试'，而是'解释哪里出错并修正策略'"

---

## 九、Sub-agent（子任务委派）

### 本项目实现
- 子 agent 封装为 tool：`delegate({goal: "sub-goal"})`
- Durable key namespace 嵌套：父 `t1:call_1:` → 子 `t1:call_1:sub:`

### 工业界 & 前沿
| 做法 | 说明 |
|------|------|
| **并行子 agent** | fan-out/fan-in，多个子任务并发执行 |
| **超时 + 深度限制** | 防止无限套娃 |
| **LangGraph subgraph** | 独立状态、工具、interrupt 点 |
| **上下文隔离** | 明确子 agent 信息访问边界，不污染父 agent 窗口 |

### 要点
- "子 agent 的价值是上下文隔离——繁重子任务不污染主 agent 的窗口"

---

## 十、Session（多轮用户对话）

> 核心命题：让 agent 不只是"一次 prompt → 一次完成"，而是支持用户反复追问、迭代 refine 的真实对话体验。

### 问题

agent-harness 的 `runAgent(goal)` 和 durable-agent-runtime 的 `runtime.run(issue)` 都是**单次执行模型**：
一次 prompt 进去 → agent 内部多轮 think/tool → 返回结果 → 结束。用户不满意结果时，没有任何机制
能在保留上下文的前提下追加新的 prompt。

### 本项目的实现

```
Session (session.ts)
  ├─ Run₁: 用户 "修登录bug"  →  agent 推理 →  结果₁
  ├─ Run₂: 用户 "加测试"    →  带上文推理 →  结果₂
  └─ Run₃: 用户 "换个方案"  →  带全部上文 →  结果₃
```

**两层改动：**

| 层 | 改动 | 文件 |
|------|------|------|
| harness | `RunAgentOptions` 新增 `conversationHistory?: Message[]`；`initLoopState` 在 system prompt 和 goal 之间插入历史；支持 `'system'` role 承载摘要 | `agent-harness/src/control/loop.ts` |
| runtime | `RunInput` 新增 `conversationHistory`（role 扩展为 `'user'\|'assistant'\|'system'`）；`runtime.run()` 签名扩展；`runtime.completeText()` 暴露文本补全入口供摘要使用；`makeContext` / harness-adapter / agent-loop 全线透传 | `types.ts` · `runtime.ts` · `workflow.ts` · `harness-adapter.ts` · `agent-loop.ts` |
| session | **新模块** `SessionManager`：JSON manifest 存储 session→runIds 映射 + `runSummaries` 缓存；`start()` / `continue()` / `list()` / `get()`；两种 history 模式 | `durable-agent-runtime/src/session.ts` |
| summarizer | `ConversationSummarizer` 类型 + `createConversationSummarizer()` 工厂；`harness-adapter` 导出 `extractHarnessMessages()` 提取全量 message transcript | `session.ts` · `harness-adapter.ts` |
| CLI | `agent chat` REPL + `--list` / `--history` / `--resume` 子命令；`SESSION_HISTORY_MODE` / `SESSION_VERBATIM_MODE` 环境变量控制摘要行为 | `cli.ts` |

**两种 History 模式：**

| 模式 | 环境变量 | 行为 |
|------|---------|------|
| `qa-pairs`（默认） | `SESSION_HISTORY_MODE=qa-pairs` | 每个 prior run → user prompt + assistant answer 对，全量 verbatim。零 LLM 开销 |
| `full-summary` | `SESSION_HISTORY_MODE=full-summary` | 每个 older run 的**全量 message transcript**（含 tool calls/results）通过 LLM 摘要为一段 system message；最近 N 个 run 保持 verbatim（QA 或 full messages）。摘要结果缓存在 `SessionManifest.runSummaries` 中，**每个 run 最多摘要一次，跨 continue() 调用不重复** |

**核心数据流（`continue`）：**
```
// Mode 1: qa-pairs（默认）
SessionManager.continue(sessionId, newPrompt)
  → 遍历 session.runIds，对每个 run 调 runtime.status() 取 (user prompt + assistant answer)
  → 组装 conversationHistory: [{role:'user',...}, {role:'assistant',...}, ...]
  → runtime.run(newPrompt, { conversationHistory })
    → workflow step → harness-adapter
      → runAgent({ goal, conversationHistory })
        → initLoopState: [system, ...history, user(goal)]

// Mode 2: full-summary（增量缓存）
SessionManager.continue(sessionId, newPrompt)
  → 遍历 olderRunIds，检查 manifest.runSummaries[runId]：
    - 有缓存 → 跳过（不重复调 LLM）
    - 无缓存 → 调 extractMessages(run) 取全量 transcript → 批处理调 LLM 摘要
      → 缓存到 manifest.runSummaries[每个 runId]
  → 累积所有缓存摘要 → 拼成一条 system message
  → 最近 N 个 run 的 verbatim context（QA 或 full messages）
  → runtime.run(newPrompt, { conversationHistory })
```

**存储设计：**
```
.agent-runs/
  sessions/
    <sessionId>.json   ← { sessionId, runIds[], title, createdAt, updatedAt }
  runs/
    <runId>/           ← 现有事件日志（完全不变）
```

Session 不事件溯源——它是轻量指针结构，JSON manifest 足够简单、可内省、可修复。

### 工业界对照

| 产品/框架 | Session 实现 |
|-----------|-------------|
| **ChatGPT / Claude** | 服务端维护 conversation thread；前端每次请求带 thread_id，后端拼接历史 |
| **OpenAI Agents SDK** | `Session` 对象：`items[]`（输入+输出对），`create_session` / `resume_session` |
| **LangGraph** | `Thread` + `State`：`thread_id` 持久化图状态；checkpointer 自动保存每个 super-step |
| **Vercel AI SDK** | `id` + `messages[]`：`useChat` hook 维护客户端消息列表；服务端 `append()` / `regenerate()` |
| **Google ADK / A2A** | `context_id` + `Task` 对象：任务有状态（`working`/`needs-input`/`completed`） |

### 设计决策

- **Session 不入事件日志** — session 是 run 之间的链接，不是需要回放的状态；JSON manifest 更简单
- **两种 history 模式** — `qa-pairs` 零开销默认行为；`full-summary` 按需开启，LLM 摘要增量缓存不复算
- **摘要缓存 per-run** — `manifest.runSummaries` 保证每个 run 只摘要一次；增量式——新 run 只摘要新增 run
- **摘要可选 full transcript** — `extractMessages` 提取 harness 的完整 Message[]（含 tool calls/results），摘要质量远高于仅看 Q&A 对
- **对话上下文压缩留给 harness ContextManager** — 现有 token 预算 + compaction 机制直接生效，长对话自动裁剪旧消息
- **跨 session 记忆正交** — 已有 `memory/store.ts`，与本需求互不冲突

### 当前不足
| 差距 | 说明 |
|------|------|
| ~~自动摘要旧对话~~ | ✅ 已通过 `full-summary` 模式 + incrementally-cached LLM summarization 解决 |
| 对话分叉 | 不支持从中间某轮 checkpoint 分叉出新 session |
| 多 session 并发 | v1 单用户 REPL，未做并发安全 |
| Session 级 metrics | 无跨 run 的 token 总计、对话轮次统计 |
| 摘要质量退化 | 多轮摘要累积可能漂移；暂未做摘要一致性校验
