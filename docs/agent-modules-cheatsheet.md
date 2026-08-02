# Agent Runtime — 核心模块速查

---

## agent-contracts（缝）

| 模块 | 一句话 |
|------|--------|
| `messages` / `tools` / `model` | Chat 对话、ToolInvoker、ChatModel |
| `keys.ts` | 幂等 key 词汇表 `keyScope` |
| `dead-letter.ts` | `DeadLetter` / `DeadLetterQueue` / `deadLetterId` |
| `approval.ts` | `Approver` / `ApprovalStats` 类型（实现在 harness） |
| `corpus.ts` | `CorpusScoped` — skill/host 绑定文档库 |

---

## agent-harness（Agent 大脑 · 运行时无关）

### A — 协议层
| 模块 | 一句话 |
|------|--------|
| `protocol/tool-calling.ts` | ChatResponse → 已校验的 tool call 或 final answer；非法调用变 observation 不抛异常 |
| `schema/validate.ts` | 零依赖 JSON Schema 子集校验，只覆盖 tool input 需要 |

### B — 恢复层
| 模块 | 一句话 |
|------|--------|
| `recovery/retry.ts` | Full-jitter 指数退避 + HTTP 状态分类 + Retry-After；per-run retryBudget 熔断；`RetryingToolInvoker`（`ToolInvoker` 装饰器） |
| `recovery/loop-detector.ts` | 滑动窗口 + A→B→A→B 序列检测 + per-tool 调用上限；`sequenceMutatingTools`（序列限定写工具）· `successResets`（成功重置计数）· `advisoryTools`（只读/验证 trip 降级轻推） |
| `recovery/circuit-breaker.ts` | closed→open→half_open 三态熔断器 |
| `recovery/fallback.ts` | 多 tier 分级模型链 + escalation ladder，零侵入 ChatModel |
| `recovery/compensation.ts` | Saga 补偿：LIFO 回滚已提交副作用（opt-in 装饰器） |
| `recovery/dead-letter.ts` | 死信装饰器 + `retryDeadLetter`；`DeadLetter*` / `deadLetterId` 类型在 `@agent/contracts` |

### C — 上下文层
| 模块 | 一句话 |
|------|--------|
| `context/manager.ts` | Token 预算硬顶；atomic tool-call 单元淘汰；近期 pin + `ImportanceClass` 折扣扩窗；`protectVerbatimClasses` 显式保护名单；untrusted 隔离；keyed LLM 主动压缩；折掉的 tool 结果附确定性 re-call notice |
| `context/retrieval.ts` | Query-time RAG 注入：gate（minScore / maxChunks / char 预算）→ `kind: 'retrieval'` + untrusted 消息；分数低于真人指令；不持有索引 |
| `context/tokenizer.ts` | 默认 `tiktokenTokenizer`（cl100k_base）；可换 CJK-aware / heuristic / `fromCounter` |
| `context/scratchpad.ts` | 超大工具输出卸载到外部存储，窗口留指针 |

### D — 控制流
| 模块 | 一句话 |
|------|--------|
| `control/loop.ts` | 核心 `runAgent`(batch) + `runAgentStreamed`(streaming)；tool 并行/concurrency、stopOnUse、structured output、error handlers、lifecycle hooks（含 `onInterrupt`）；turn 边界过 `RunInterrupter` |
| `control/planner.ts` | 先规划后执行 + 进度 ✓/→/○ + 失败重规划；`PlanReviewer`（approve/edit/reject+remake） |
| `control/reflection.ts` | 模型自评 → 不满意重来（Reflexion 简化版） |
| `control/subagent.ts` | 子 agent 封装为 tool，key namespace 嵌套；`AsyncLocalStorage` 追踪实际嵌套深度，`maxDepth`（默认 5）超限拒绝并转成普通工具错误观测 |
| `control/human.ts` | 工具级 HITL：glob 审批门控 + 时效缓存 + 参数可修改 + countingApprover |
| `control/interrupt.ts` | Run 级 HITL：turn 边界 pause/steer/abort；默认 autoContinue；`createInterruptHandle` |

### Skills（playbook · 与 sub-agent 正交）
| 模块 | 一句话 |
|------|--------|
| `agent.ts` | `AgentConfig` + `createAgent`：物化 `skills` / `subAgents`（idempotent `resolved`） |
| `skills/types.ts` | `SkillSpec` / `SkillLoadMode`；可选 `corpusId`（playbook 绑定知识库） |
| `skills/load.ts` | `parseSkillMarkdown` / `loadSkillFile`（轻量 frontmatter，零 YAML 依赖） |
| `skills/tools.ts` | on_demand：`skill_list` + `skill_read`（静态正文，durable 下也可本地挂） |
| `skills/resolve.ts` | catalog 注入 instructions；eager 内联正文；subAgents → `delegate_<name>`；**skills 不 inherit 到子 agent** |

---

## durable-agent-runtime（执行底座 · 事件溯源）

### 平台核心
| 模块 | 一句话 |
|------|--------|
| `runtime.ts` | 驱动 phase→step 执行；组装 StepContext；幂等 / resume / recover |
| `step-context.ts` | 统一漏斗 `callModel` / `callChat` / `callTool`（幂等 key + policy + 落盘） |
| `eventlog.ts` | Append-only 事件日志；默认乐观并发（wx + ConflictError）；可关 → 单 run 单 `events.json`（`optimisticConcurrency: false`，单写者）。**分级持久化**——critical 同步落盘，relaxed 先缓存、与下一个 critical 合并写。真实工作流 benchmark 实测减少 49% 写入 |
| `reducer.ts` | 纯函数 fold：`(state, event) => state`；State 永远派生，不落盘 |
| `snapshot.ts` | 周期性状态快照，tmp+rename 原子写，加速 resume |
| `session.ts` | 多轮对话 `SessionManager`：串联 run→对话线程，两种 history 模式（`qa-pairs` / `full-summary` 增量 LLM 摘要缓存）；JSON manifest + `runSummaries`；`createConversationSummarizer` 工厂 |
| `types.ts` | `AgentEvent`（14 种 discriminated union，含 `HumanIntervention`）+ 派生态 `RunState` |
| `workflow.ts` | `WorkflowDef/PhaseDef/StepDef/StepContext` — 工作流契约；可选 `callChat`；`emit` 追加 observability 事件 |

### 策略 & 安全
| 模块 | 一句话 |
|------|--------|
| `policy.ts` | 声明式护栏：tool allow-list + 成本预算 + PII 脱敏 + **token-bucket 限流**（按工具，进程内存、故意不事件源化） |
| `policy/content-safety.ts` | 可插拔 safety provider：jailbreak 检测 + 有害内容检测 + 输出安全检查 |
| `dead-letter-store.ts` | `FileDeadLetterQueue`：`@agent/contracts` `DeadLetterQueue` 的磁盘实现，接入 `runtime.ts` 的 `callTool` 漏斗 |

### 模型 & 工具
| 模块 | 一句话 |
|------|--------|
| `model/provider.ts` | `ModelProvider.complete(text) → ModelResult` — 文本 LLM |
| `model/chat-provider.ts` | `ChatModelProvider.chat(messages, tools) → ChatResponse` + envelope 编解码（durable `callChat`） |
| `model/provider.ts` / `chat-provider.ts` | 文本 / Chat provider；`Usage.cachedPromptTokens` 来自 provider |
| `tools/registry.ts` | `ToolDef/ToolRegistry` — 本地工具和 MCP 工具统一接口 |
| `index.ts` | 库导出：供外部宿主（如 coding-agent）使用 Runtime / harness-adapter / ToolRegistry / `FileDeadLetterQueue` / `eval.ts` 全套打分器（`runEval`/`renderReport`/`Scenario`/scorers） |

### MCP（共享 SDK）
| 模块 | 一句话 |
|------|--------|
| `mcp/client.ts` | JSON-RPC 客户端框架 |
| `mcp/transport.ts` | 可换 transport（in-memory/HTTP/stdio） |
| `mcp/token-cache.ts` | 共享 token 缓存，多 server 复用认证 |

### 记忆 & 可观测
> 两套 trace + eval 字段对照见 [`observability-trace-and-eval.md`](./observability-trace-and-eval.md)。

| 模块 | 一句话 |
|------|--------|
| `memory/store.ts` | 跨会话持久记忆：分 scope + 内容哈希幂等写；FileMemoryStore 原子写；`search` async；`mode: lexical/semantic/hybrid` |
| `memory/lexical.ts` | 零依赖 mini-BM25 词法打分（含 常见 CJK），确定性检索 |
| `memory/embedding.ts` | async-first `EmbeddingProvider`（可选 `embedMany`）+ 默认 `HashingEmbeddingProvider` + `CachingEmbeddingProvider` + `createHttpEmbeddingProvider` + RRF |
| `retrieval/` | 文档 RAG：`InMemoryDocumentStore` / `FileDocumentStore`；`RetrievalPolicy`（`once` / `once_rewrite` / `capped_agentic`）；`resolveRunCorpusId` / `collectSkillCorpora`；`systemRetrieveOnce` |
| `app/document-tools.ts` | `document_search` / `document_read`（default + allow-list corpus；走 durable seam） |
| harness `tracing/collector.ts` | 现场埋点：turn / tool args / assemble·compact 决策（含 `removedToolResults`）/ 压缩后同签名再调（`recalledTools`）/ token 估价（非 event-log） |
| `trace.ts` | 从事件日志派生 span 时间线 + token/成本/延迟/replay/policy/cache 汇总 |
| `otel.ts` | 把 `trace.ts` 的 span 桥接成真正的 OpenTelemetry span（父子嵌套 + 历史时间戳），无 collector 时退回 console 导出 |
| `eval.ts` | 可组合打分器（结果性 + 过程性/轨迹 + 人机协同 + 护栏回归）+ runner；读 runtime Trace + RunState；`Scenario.harness`/`approver` 可改路由到 harness 循环 |

### 桥接
| 模块 | 一句话 |
|------|--------|
| `app/harness-adapter.ts` | 在 StepContext 上实现 ChatModel+ToolInvoker，透传 key；优先 `callChat`，否则文本桥+`parseTextToolCall`；retrieve 预算 / skill corpus；`createHarnessWorkflow({ agent, approver, interrupter, trace, … })` |
| `app/demo-fixtures.ts` · `app/demo-runtime.ts` | 共享 demo 答案与 Runtime 工厂（CLI run/eval + 测试同一接线） |

---

## 核心设计理念（一句话级）

| 理念 | 说明 |
|------|------|
| **缝** | `@agent/contracts`：平台与 harness 的共享边界；runtime **平台**不依赖 harness；`src/app/` 适配器可依赖 harness。`MessageKind`（`goal` / `retrieval`）标识结构意图 |
| **key 即契约** | `t{turn}` / `t{turn}:{callId}` → adapter 透传 → runtime idempotency cache → crash 后 replay 不重放 |
| **状态全派生** | RunState 永远从事件日志 reduce 得出，不落盘；snapshot 是可选加速 |
| **错误→observation** | 工具抛错/参数非法/loop 检测 → 结构化错误喂回模型 → 模型自愈 |
| **分层** | harness = 无状态 loop 引擎；runtime = 有状态持久化底座；policy = 声明式护栏 |
| **skills ≠ sub-agent** | skill = 当前 agent 的 playbook（上下文）；sub-agent = 嵌套 run；skills 不自动 inherit |
| **指令 > 证据** | `ImportanceClass`：真人 `user_instruction` > RAG `retrieval`；compact 保护看 `protectVerbatimClasses` 名单 |
| **两层 HITL** | `Approver` 管单次工具；`RunInterrupter` 管整条 run（默认不挡）；`PlanReviewer` 管规划清单 |
