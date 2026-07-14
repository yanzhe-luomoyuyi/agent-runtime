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
| `recovery/retry.ts` | Full-jitter 指数退避 + HTTP 状态分类 + Retry-After；per-run retryBudget 熔断 |
| `recovery/loop-detector.ts` | 滑动窗口 + A→B→A→B 序列检测 + per-tool 调用上限 |
| `recovery/circuit-breaker.ts` | closed→open→half_open 三态熔断器 |
| `recovery/fallback.ts` | 多 tier 分级模型链 + escalation ladder，零侵入 ChatModel |
| `recovery/compensation.ts` | Saga 补偿：LIFO 回滚已提交副作用（opt-in 装饰器） |

### C — 上下文层
| 模块 | 一句话 |
|------|--------|
| `context/manager.ts` | Token 预算硬顶 + 重要性加权淘汰 + untrusted 输出隔离 + keyed LLM 主动压缩 |
| `context/tokenizer.ts` | CJK ≈ 1 token/字估算；`fromCounter` 可接 tiktoken |
| `context/scratchpad.ts` | 超大工具输出卸载到外部存储，窗口留指针 |

### D — 控制流
| 模块 | 一句话 |
|------|--------|
| `control/loop.ts` | 核心 `runAgent`(batch) + `runAgentStreamed`(streaming)；tool 并行/concurrency、stopOnUse、structured output、error handlers、9 lifecycle hooks |
| `control/planner.ts` | 先规划后执行 + 进度 ✓/→/○ + 失败重规划 |
| `control/reflection.ts` | 模型自评 → 不满意重来（Reflexion 简化版） |
| `control/subagent.ts` | 子 agent 封装为 tool，key namespace 嵌套 |
| `control/human.ts` | glob 审批门控 + 时效缓存 + 参数可修改 |

---

## durable-agent-runtime（执行底座 · 事件溯源）

### 平台核心
| 模块 | 一句话 |
|------|--------|
| `runtime.ts` | 驱动 phase→step 执行；统一漏斗 callModel/callTool；幂等 idempotency cache |
| `eventlog.ts` | Append-only 事件日志；每个事件独占文件；乐观并发（wx + ConflictError） |
| `reducer.ts` | 纯函数 fold：`(state, event) => state`；State 永远派生，不落盘 |
| `snapshot.ts` | 周期性状态快照，tmp+rename 原子写，加速 resume |
| `session.ts` | 多轮对话 `SessionManager`：把多个 run 串联为对话线程，后续 run 自动携带上文 conversationHistory；JSON manifest 存储 |
| `types.ts` | `AgentEvent`（13 种 discriminated union）+ 派生态 `RunState` |
| `workflow.ts` | `WorkflowDef/PhaseDef/StepDef/StepContext` — 工作流契约 |

### 策略 & 安全
| 模块 | 一句话 |
|------|--------|
| `policy.ts` | 声明式护栏：tool allow-list + 成本预算 + PII 脱敏 |
| `policy/content-safety.ts` | 可插拔 safety provider：jailbreak 检测 + 有害内容检测 + 输出安全检查 |

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
| 模块 | 一句话 |
|------|--------|
| `memory/store.ts` | 跨会话持久记忆：分 scope + 内容哈希幂等写；FileMemoryStore 原子写 |
| `memory/lexical.ts` | 零依赖 mini-BM25 词法打分（含 CJK），确定性检索 |
| `trace.ts` | 从事件日志派生 span 时间线 + token/成本/延迟汇总 |
| `otel.ts` | 把 `trace.ts` 的 span 桥接成真正的 OpenTelemetry span（父子嵌套 + 历史时间戳），无 collector 时退回 console 导出 |
| `eval.ts` | 可组合打分器（结果性 + 过程性/轨迹 + 人机协同 + 护栏回归）+ runner；`Scenario.harness`/`approver` 可将场景改路由到 @agent/harness 循环 |

### 桥接
| 模块 | 一句话 |
|------|--------|
| `app/harness-adapter.ts` | 在 StepContext 上实现 ChatModel+ToolInvoker，透传 key；把 runAgent 封装为 durable step |
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
