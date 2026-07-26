# Agent Runtime — 核心模块速查

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
| `recovery/loop-detector.ts` | 滑动窗口 + A→B→A→B 序列检测 + per-tool 调用上限 |
| `recovery/circuit-breaker.ts` | closed→open→half_open 三态熔断器 |
| `recovery/fallback.ts` | 多 tier 分级模型链 + escalation ladder，零侵入 ChatModel |
| `recovery/compensation.ts` | Saga 补偿：LIFO 回滚已提交副作用（opt-in 装饰器） |
| `recovery/dead-letter.ts` | 死信队列：`DeadLetterToolInvoker`（opt-in 装饰器，与 retry 组合使用）+ `retryDeadLetter()` 人工重放 |

### C — 上下文层
| 模块 | 一句话 |
|------|--------|
| `context/manager.ts` | Token 预算硬顶；atomic tool-call 单元淘汰；近期 pin + 重要性折扣扩窗；untrusted 隔离；keyed LLM 主动压缩 |
| `context/retrieval.ts` | Query-time RAG 注入：gate（minScore / maxChunks / char 预算）→ untrusted 消息；不持有索引 |
| `context/tokenizer.ts` | CJK ≈ 1 token/字估算；`fromCounter` 可接 tiktoken |
| `context/scratchpad.ts` | 超大工具输出卸载到外部存储，窗口留指针 |

### D — 控制流
| 模块 | 一句话 |
|------|--------|
| `control/loop.ts` | 核心 `runAgent`(batch) + `runAgentStreamed`(streaming)；tool 并行/concurrency、stopOnUse、structured output、error handlers、9 lifecycle hooks |
| `control/planner.ts` | 先规划后执行 + 进度 ✓/→/○ + 失败重规划 |
| `control/reflection.ts` | 模型自评 → 不满意重来（Reflexion 简化版） |
| `control/subagent.ts` | 子 agent 封装为 tool，key namespace 嵌套；`AsyncLocalStorage` 追踪实际嵌套深度，`maxDepth`（默认 5）超限拒绝并转成普通工具错误观测 |
| `control/human.ts` | glob 审批门控 + 时效缓存 + 参数可修改 |

### Skills（playbook · 与 sub-agent 正交）
| 模块 | 一句话 |
|------|--------|
| `agent.ts` | `AgentConfig` + `createAgent`：物化 `skills` / `subAgents`（idempotent `resolved`） |
| `skills/types.ts` | `SkillSpec` / `SkillLoadMode`（`eager` \| `on_demand`） |
| `skills/load.ts` | `parseSkillMarkdown` / `loadSkillFile`（轻量 frontmatter，零 YAML 依赖） |
| `skills/tools.ts` | on_demand：`skill_list` + `skill_read`（静态正文，durable 下也可本地挂） |
| `skills/resolve.ts` | catalog 注入 instructions；eager 内联正文；subAgents → `delegate_<name>`；**skills 不 inherit 到子 agent** |

---

## durable-agent-runtime（执行底座 · 事件溯源）

### 平台核心
| 模块 | 一句话 |
|------|--------|
| `runtime.ts` | 驱动 phase→step 执行；统一漏斗 callModel/callTool；幂等 idempotency cache |
| `eventlog.ts` | Append-only 事件日志；乐观并发（wx + ConflictError）；**分级持久化**——critical 事件（状态转换）同步落盘，relaxed 事件（无状态转换 + PhaseStarted/StepStarted 这种可无损重算的）先缓存、与下一个 critical 事件合并成一次写。真实工作流 benchmark 实测减少 49% 写入 |
| `reducer.ts` | 纯函数 fold：`(state, event) => state`；State 永远派生，不落盘 |
| `snapshot.ts` | 周期性状态快照，tmp+rename 原子写，加速 resume |
| `session.ts` | 多轮对话 `SessionManager`：串联 run→对话线程，两种 history 模式（`qa-pairs` / `full-summary` 增量 LLM 摘要缓存）；JSON manifest + `runSummaries`；`createConversationSummarizer` 工厂 |
| `types.ts` | `AgentEvent`（13 种 discriminated union）+ 派生态 `RunState` |
| `workflow.ts` | `WorkflowDef/PhaseDef/StepDef/StepContext` — 工作流契约 |

### 策略 & 安全
| 模块 | 一句话 |
|------|--------|
| `policy.ts` | 声明式护栏：tool allow-list + 成本预算 + PII 脱敏 + **token-bucket 限流**（按工具，进程内存、故意不事件源化） |
| `policy/content-safety.ts` | 可插拔 safety provider：jailbreak 检测 + 有害内容检测 + 输出安全检查 |
| `dead-letter-store.ts` | `FileDeadLetterQueue`：`@agent/harness` `DeadLetterQueue` 接口的磁盘持久化实现，接入 `runtime.ts` 的 `callTool` 漏斗 |

### 模型 & 工具
| 模块 | 一句话 |
|------|--------|
| `model/provider.ts` | `ModelProvider.complete(text) → ModelResult` — 可换 LLM |
| `model/caching.ts` | 内容寻址 LRU 缓存装饰器（sha256 正则化 prompt） |
| `tools/registry.ts` | `ToolDef/ToolRegistry` — 本地工具和 MCP 工具统一接口 |

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
| `retrieval/` | 文档 RAG：`DocumentStore` / `StoreRetriever` / `RetrievalPolicy`（默认 `once`；`capped_agentic` + `maxRetrieves` 硬顶）/ `systemRetrieveOnce`；search 可选 `maxTextChars` |
| `app/document-tools.ts` | `document_search` / `document_read`（corpus 绑定；走 durable seam） |
| `app/harness-adapter.ts` | harness↔runtime；`RuntimeToolInvoker` 可按 state 强制 document_search 预算 |
| harness `tracing/collector.ts` | 现场埋点：turn / tool args / assemble·compact 决策 / token 估价（非 event-log） |
| `trace.ts` | 从事件日志派生 span 时间线 + token/成本/延迟/replay/policy/cache 汇总 |
| `otel.ts` | 把 `trace.ts` 的 span 桥接成真正的 OpenTelemetry span（父子嵌套 + 历史时间戳），无 collector 时退回 console 导出 |
| `eval.ts` | 可组合打分器（结果性 + 过程性/轨迹 + 人机协同 + 护栏回归）+ runner；读 runtime Trace + RunState；`Scenario.harness`/`approver` 可改路由到 harness 循环 |

### 桥接
| 模块 | 一句话 |
|------|--------|
| `app/harness-adapter.ts` | 在 StepContext 上实现 ChatModel+ToolInvoker，透传 key；`createHarnessWorkflow({ agent: { skills } })` 可传入 persona/skills |
| `agent-loop.ts` | 内置简化版 agent 循环（已被 harness 取代，保留用于对比） |

---

## 核心设计理念（一句话级）

| 理念 | 说明 |
|------|------|
| **缝** | `@agent/contracts` 纯类型，harness 和 runtime 各不依赖对方 |
| **key 即契约** | `t{turn}` / `t{turn}:{callId}` → adapter 透传 → runtime idempotency cache → crash 后 replay 不重放 |
| **状态全派生** | RunState 永远从事件日志 reduce 得出，不落盘；snapshot 是可选加速 |
| **错误→observation** | 工具抛错/参数非法/loop 检测 → 结构化错误喂回模型 → 模型自愈 |
| **分层** | harness = 无状态 loop 引擎；runtime = 有状态持久化底座；policy = 声明式护栏 |
| **skills ≠ sub-agent** | skill = 当前 agent 的 playbook（上下文）；sub-agent = 嵌套 run；skills 不自动 inherit |
