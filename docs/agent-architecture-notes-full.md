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

### 大规模自动评分

生产环境几千条 trace 不可能人工写参考答案。实际做法是三层组合：

| 方式 | 需要参考答案吗 | 覆盖规模 | 精度 |
|------|-------------|---------|------|
| **规则打分**（cost / latency / success rate / turns / policy） | ❌ 零依赖 | 100% 生产 trace | 低但可靠——只看"跑得怎么样"不看"答得怎么样" |
| **LLM-judge**（按准则评价） | ❌ 不需要标准答案 | 100% 生产 trace | 中——LLM 看 agent 输出并按标准直接打分，有偏差风险 |
| **Reference-based**（断言式检查点） | ✅ 需要人工写 reference | 回归测试集（几十条） | 高——回答必须踩中关键点 |

**数据闭环：**

```
生产 trace（几千条）
  │
  ├─ 规则 + LLM-judge 全自动打分 → 发现低分 trace
  │     └→ 人工抽样分析根因 → 改 prompt / 换 model / 修 tool
  │
  ├─ 筛选高分 trace → 提取 prompt + output 对 → 自动变成 few-shot 示例塞回 prompt
  │
  └─ 回归测试数据集（几十条精选 scenario，带断言）→ 精确评测 → 确认改进
```

这就是完整的 **Eval 闭环**：trace 不是事后看的报表，而是下一次改进的输入——自动打分 → 不合格标记 → 反馈改进。

### 要点
- "tracing 不是事后诸葛亮，是 eval 的输入——生产 trace → 自动评分 → 回归检测"
- "OTel 导出属于运行时层，不属于 harness——因为它需要真实网络 IO，harness 只产出结构化数据"
- "大规模自动打分 = 规则（全量） + LLM-judge（全量） + 断言检查点（回归测试集）。前两者不需要参考答案"
- "参考答案只留给最重要的几十条回归测试——而非几千条生产 trace"

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
- ✅ 已升级到 L2 结构化诊断：`Critique` 不再只是 pass/fail，新增 `rootCause`（为什么没达标）/ `correctionStrategy`（怎么修）/ `whatWorked`（哪些部分已经对了，不用重做）
- `buildRevisedGoal()` 把结构化诊断编织进下一轮 goal；对只返回 L1 形状的 critique 自动降级为纯 feedback 拼接，向后兼容
- `maxReflections` + 独立 key 命名空间（`a0:` / `a1:`）

### 工业界 & 前沿
| 做法 | 说明 |
|------|------|
| **Reflexion (2023)** | 结构化反思：哪步出错 + 如何修正（比 pass/fail 更精细） |
| **Self-Consistency (2022)** | 同一问题跑 3-5 次，投票决定最终答案 |
| **验证工具集成** | 跑实际 test suite 而非模型自我判断 |
| **反思记忆** | 上次反思的教训跨 run 保留 |

### 工业界成熟度分层

Reflection 的实现可以分成五个递进层次，从最小可行版本到研究前沿：

```
L1: Pass/Fail 二元反思        ← 本项目升级前的实现
L2: 结构化诊断反思 (Reflexion)  ← 本项目当前实现 ✅
L3: 多维度评分反思
L4: 工具验证反思（不靠模型自评）
L5: 反思记忆化 + 跨 run 复用
```

| 层级 | 做法 | 工业界采用率 | 代表 |
|------|------|-------------|------|
| **L1** | Pass/fail + 自由文本反馈 | ⭐⭐⭐⭐⭐ 极高 | 多数生产 agent 的起点 |
| **L2** | 结构化诊断（root cause + correction strategy + what worked） | ⭐⭐⭐ 中 | 本项目、Reflexion 论文、部分代码 agent |
| **L3** | 多维度评分（correctness / completeness / safety / clarity） | ⭐⭐⭐ 中 | Constitutional AI、企业 RAG |
| **L4** | 工具验证（跑测试 / 执行 SQL / 符号计算，而非 LLM 自评） | ⭐⭐⭐⭐ 高（限代码/数学/SQL 领域） | SWE-agent、Devin、AlphaCode |
| **L5** | 反思记忆跨任务复用（embedding 检索历史失败教训） | ⭐ 低，多在研究阶段 | Reflexion 论文、Generative Agents |

**为什么工业界对 L4/L5 仍谨慎：**
- 成本：每加一层反思至少多一次 LLM 调用，L4 还要真实执行（编译/跑测试），latency 和费用叠加
- 反思质量不稳定：LLM 自我诊断"我错在哪"有时是编造的，缺乏 actionable 信息
- 无限循环风险：critic 一直不满意就要靠 `maxReflections` 硬顶
- 记忆漂移（L5）：跨任务检索到不相关的历史反思反而误导当前任务
- 自我评审的天花板悖论：critic 和 answerer 是同一能力水平，模型给不出正确答案时，评审自己的答案往往也判断不准

**下一步升级方向（若任务领域有确定性验证器）：** 优先做 L4——例如涉及代码修改的任务，跑测试判断正确性比 LLM 自评可靠得多；L5 的跨任务记忆检索噪声问题目前业界也没有很好的解法，建议观望。

### 要点
- "Reflexion 的核心不是'重试'，而是'解释哪里出错并修正策略'"
- "L4 工具验证 > L1-L3 模型自评——只要任务领域有编译器/测试框架/执行环境，就该用它代替 LLM 自评"

---

## 九、Sub-agent（子任务委派）

### 本项目实现
- 子 agent 封装为 tool：`delegate({goal: "sub-goal"})`
- Durable key namespace 嵌套：父调用 key（如 `t1:p1`）作为子 loop 的 `keyPrefix` → 子 key 形如 `t1:p1:t1:s1`
- ❌ 当前无深度限制：`delegate` 若出现在子 agent 的工具集里可无限递归，直到 `maxTurns`/token 预算耗尽才停

### 工业界 & 前沿
| 做法 | 说明 |
|------|------|
| **并行子 agent** | fan-out/fan-in，多个子任务并发执行 |
| **超时 + 深度限制** | 防止无限套娃 |
| **LangGraph subgraph** | 独立状态、工具、interrupt 点 |
| **上下文隔离** | 明确子 agent 信息访问边界，不污染父 agent 窗口 |
| **Handoff（transfer-and-forget）** | OpenAI Agents SDK / AutoGen / Swarm：控制权彻底转移给另一个 agent，原 agent 不再等待结果——区别于 delegate 的"call-and-return" |
| **Orchestrator-Worker** | Anthropic 多智能体研究系统：主 agent 只做规划+综合，worker 并行独立执行、各自独立上下文窗口，orchestrator 动态决定 worker 数量和每个的任务预算 |
| **Supervisor 路由模式** | LangGraph 推荐范式：supervisor 不参与任务分解，只做"这个问题该交给谁"的路由决策，每个 sub-agent 是完整独立的专家 |
| **Budget 传播** | 父 agent 的 token/时间预算按比例分给子 agent，防止子 agent 无限制消耗拖垮父 agent 自身的预算 |
| **结果聚合策略** | Map-Reduce（结构化合并而非文本拼接）/ 投票共识（类 Self-Consistency）/ 分层合并（避免子结果一次性塞爆父窗口） |

### 要点
- "子 agent 的价值是上下文隔离——繁重子任务不污染主 agent 的窗口"
- "Delegate 和 Handoff 是互补的：delegate 适合'完成后要汇总'，handoff 适合'对话主导权转移'"
- "多智能体系统最大的隐藏成本不是 token，是调试——没有 trace 传播机制（parent_span_id 关联），出错了根本不知道是哪个子 agent 的哪一步"

---

## 十、Session（多轮用户对话）

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
