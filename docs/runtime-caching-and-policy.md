# Prompt 缓存与策略护栏：架构设计与业界做法

本文档覆盖 Agent 运行时的两个平台层关注点：**prompt 缓存**（省钱）和**策略护栏**（安全）。两者都通过可替换的接口注入 Runtime，遵循相同的设计原则：数据驱动、声明式配置、provider 可插拔。

---

## 第一部分：Prompt 缓存

---

## 两层对比

```
请求进来
  │
  ├─① Runtime 层缓存（精确哈希）→ 整个 prompt 之前见过？
  │   YES → 直接返回缓存（0 API 调用、0 费用）
  │   NO  → 往下走
  │
  └─② LLM Provider 层缓存（前缀缓存）→ prompt 的前 N 个 token 之前算过？
      YES → 复用 KV-cache（input token 费用打 1-5 折）
      NO  → 全量计算
```

| 维度 | ① Runtime 层（本项目的 `caching.ts`） | ② Provider 层（Anthropic/OpenAI/DeepSeek/Gemini） |
|------|--------------------------------------|---------------------------------------------------|
| 工作层 | Agent 进程内，调 API 之前 | LLM 服务端，GPU 推理时 |
| 匹配方式 | 整个 prompt 的 sha256 哈希 | token 级的 prefix match |
| 命中条件 | prompt 完全一致 | prompt 开头 N 个 token 完全一致 |
| 命中收益 | **100% 节省**（不调 API） | **~90% off** input token 费用 |
| 对 prompt 要求 | 必须完全一样 | 前缀一样即可，后缀可以不同 |
| TTL | 自己控制（文件持久化则可跨天） | 通常 5-10 分钟（Anthropic），每次命中刷新 |
| 典型命中场景 | 同一 issue 重跑、workflow step 重试 | 同一 system prompt + tools 的不同请求 |
| 实现依赖 | 零外部依赖 | 需要对接各家 API |

**关键洞察**：Runtime 缓存只能做"完全匹配"，因为 LLM 的响应是**整个 prompt 的函数**，不能把缓存的 system 响应和新的 query 响应拼起来。Provider 层的前缀缓存能做到"部分匹配"，因为它在 token 级别工作，天然知道 prompt 的哪些前缀段和之前完全一样。

---

## ① Runtime 层：精确哈希缓存

### 当前实现 (`src/model/caching.ts`)

```
prompt → normalize whitespace → sha256 → LRU lookup → hit? return : call LLM + cache
```

三个可替换的组件：

| 组件 | 接口 | 默认实现 | 可换成 |
|------|------|---------|--------|
| keying | `CacheKeyFn` | `sha256(normalizedPrompt)` | 去掉可变参数、语义 embedding |
| storage | `ResponseCache` | `InMemoryResponseCache` (LRU) | `FileResponseCache` / Redis |
| layer | `CachingModelProvider` | Decorator 模式 | 不变，包裹任何 `ModelProvider` |

**为什么是精确哈希而非语义匹配**：
- 语义匹配（embedding 相似度）多一次 embedding 调用、有误命中风险
- 对于 agent 场景，真正重复的 prompt（同一个 step 同一输入）hash 完全一致
- 简单、可靠、零额外成本

---

## ② Provider 层：各家前缀缓存做法

### Anthropic（需要显式标记）

2024 年中推出，目前文档最清晰。**在 prompt 中显式标记 `cache_control` 断点**，告诉服务端"算到这里时把 KV-cache 存下来"。

```json
{
  "system": [
    {
      "type": "text",
      "text": "You are an expert programmer...",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Tools:\n- searchCode: ...\n- getIssue: ...",
          "cache_control": { "type": "ephemeral" }
        },
        { "type": "text", "text": "Fix the null session bug on line 42" }
      ]
    }
  ]
}
```

关键规则：
- **前缀型**：缓存的是从头到断点的连续段，不能跳着缓存
- TTL **5 分钟**，每次命中刷新
- 最少 **1024 token**（Claude Sonnet）/ **2048 token**（Claude Opus）才允许缓存
- 最多 **4 个** `cache_control` 断点
- 命中时 input token **10% 计价**（省 90%）
- `cache_control` 断点必须放在**内容块的边界**上

最佳实践：把 system prompt + tool definitions 放在最前面标记缓存 → 每轮对话只算新增的 user message。

### OpenAI（自动，无需标记）

2025 年推出 Automatic Prefix Caching：

- **不需要标记**，服务端自动检测重复前缀
- 命中时 input token **50% off**
- TTL 约 5-10 分钟
- 仅对 >= 1024 token 的前缀生效
- **黑盒**：不暴露命中状态、TTL 剩余时间
- 无需改 prompt 结构，开箱即用

### DeepSeek

- 2025 年推出 context caching
- 类似 Anthropic 的 prefix caching 模型
- 需要**显式标记** `cache_control`
- 命中时 **90% off** input token 费用
- 文档中标记为 beta 功能

### Google Gemini（显式创建 + 可配置 TTL）

```python
cache = genai.cached_content.create(
    model="gemini-1.5-pro",
    contents=[...],
    ttl="3600s"
)
response = model.generate_content("query", cached_content=cache)
```

- **独立 API**创建缓存对象，后续请求引用
- TTL 可配置（最长数小时），比 Anthropic 的 5 分钟长得多
- 最少 **32768 token**
- 按缓存的 token 量收费（不管命中次数）
- 适合"大文档 + 多轮问答"场景

### 各家对比

| | Anthropic | OpenAI | DeepSeek | Gemini |
|---|---|---|---|---|
| 标记方式 | 显式 `cache_control` | 自动，无需标记 | 显式标记 | 独立 API 创建 |
| 节省比例 | 90% off input | 50% off input | 90% off input | 按缓存量收费 |
| TTL | 5 min（命中刷新） | 5-10 min | 未明确公布 | 最长数小时 |
| 最小 token | 1024 / 2048 | 1024 | 未公布 | 32768 |
| 最大断点数 | 4 个 | 不适用 | 未公布 | 不适用 |
| 可观测性 | 响应头返回命中信息 | 黑盒 | 未明确 | 明确（自己管理） |

---

## 协作示意

```
┌─ Agent 发起请求 ─────────────────────────────────────────────┐
│                                                               │
│  prompt = systemPrompt + tools + issueContext                 │
│                                                               │
│  key = sha256(normalize(prompt))                              │
│  hit = runtimeCache.get(key)   ←────── ① Runtime 层           │
│  if (hit) return hit                ← 命中的话到这里结束      │
│                                                               │
│  response = anthropic.messages.create({                       │
│    system: [{ text: systemPrompt, cache_control: {...} }],   │
│    messages: [                                                │
│      { role: "user", content: [                              │
│        { text: tools, cache_control: {...} },                │
│        { text: issueContext }       ←────── ② Provider 层     │
│      ]}                                                       │
│    ]                                                          │
│  })                                                           │
│                                                               │
│  runtimeCache.set(key, response)   ← 存入 Runtime 缓存        │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

**两个缓存覆盖不同的命中场景：**

| 场景 | Runtime 命中？ | Provider 命中？ |
|------|:---:|:---:|
| 完全相同的 prompt（同一 issue 重跑） | ✅ | ✅ |
| 同一 system + tools + 不同 issue | ❌ | ✅ |
| Session 续接：同 system + tools + 对话历史前缀相同 | ❌ | ✅ |
| 改了 system prompt | ❌ | ❌ |
| 5 分钟后（Anthropic TTL 过） | ✅ | ❌ |
| 跨天（文件持久化） | ✅ | ❌ |

---

## 第二部分：策略护栏

### 策略应该放在哪里：多层护栏架构

在工业级 Agent 系统中，护栏不是一层而是**四层**。本项目的 `policy.ts` 位于最关键的第二层。

```
┌──────────────────────────────────────────────────────────────┐
│  ① 基础设施层 (Infra / API Gateway)                          │
│     认证、限流、IP 白名单、网络隔离                            │
│     → Azure API Management / Kong / Nginx                    │
├──────────────────────────────────────────────────────────────┤
│  ② Runtime / 编排层（policy.ts 的位置）              ★       │
│     工具访问控制、成本预算、内容过滤、人机审批                  │
│     → PolicyEnforcer (policy.ts)                              │
│     → ContentSafetyProvider (content-safety.ts)               │
├──────────────────────────────────────────────────────────────┤
│  ③ Model Provider 层                                         │
│     prompt 安全检测、内容审核、脱敏                            │
│     → Azure AI Content Safety / OpenAI Moderation API        │
├──────────────────────────────────────────────────────────────┤
│  ④ Agent 指令层 (System Prompt)                              │
│     行为约束、拒绝规则、角色边界                               │
│     → system prompt 中的 "you must NOT..."                   │
└──────────────────────────────────────────────────────────────┘
```

**为什么策略应该放在 Runtime 层**：
- 工具调用和模型调用都经过同一个 funnel（`callTool` / `callModel`）
- 策略是**数据**，不是散落在各个 server 里的硬编码
- 同一个策略对所有 workflow、所有工具生效——不管工具是本地还是 MCP 的

### 当前实现 (`src/policy.ts` + `src/policy/content-safety.ts`)

#### 策略配置（声明式，来自 `agent.config.json`）

```typescript
interface Policy {
  allowedTools?: string[];      // 工具白名单
  maxCostUsd?: number;          // 累计成本上限
  redactions?: RedactionRule[]; // PII 脱敏规则
}
```

#### 已实现的护栏

| 护栏 | 方法 | 说明 |
|------|------|------|
| 工具白名单 | `checkTool(tool)` | 静态列表，拒绝未授权的工具调用 |
| 成本预算 | `checkBudget(spentUsd, target)` | 累计费用达到上限后阻断后续模型调用 |
| PII 脱敏 | `redact(text)` | 正则替换 email/phone/SSN/API key 等 |
| **内容安全** | `checkContent(text)` → async | **新增**：pre-model 有害内容检测 |
| **越狱检测** | `checkJailbreak(text)` → async | **新增**：prompt injection / DAN 攻击检测 |
| **输出安全** | `checkOutput(text, context?)` → async | **新增**：post-model 有害/非基于事实的输出检测 |

#### 内容安全 Provider（可插拔）

```
ContentSafetyProvider (interface)
  ├── checkContent(text)  → ContentCheckResult { safe, category, severity, reason }
  ├── checkJailbreak(text) → JailbreakResult    { safe, attackType, reason }
  └── checkOutput(text)    → OutputCheckResult  { safe, category, reason }

内置实现:
  NoOpContentSafety        — 默认，全部放行（向后兼容）
  PatternContentSafety     — 测试用，正则匹配拦截
```

生产环境接入方式：

| Provider | 对接方式 |
|----------|---------|
| **Azure AI Content Safety** | 实现 `ContentSafetyProvider`，内部调 REST API |
| **Meta Llama Guard 3** | 同上，调推理端点 |
| **OpenAI Moderation API** | 同上，调 `moderations.create()` |
| **Nvidia NeMo Guardrails** | 同上，调 gRPC/HTTP 端点 |

#### 集成流程（在 runtime.ts 的 `callModel` funnel 中）

```
prompt 进入 callModel
  │
  ├─ enforceBudget()          ← 成本检查（同步）
  │
  ├─ checkJailbreak(prompt)   ← pre-model 越狱检测（异步）
  │   └─ 不安全 → 记录 PolicyDenied 事件 → 抛 PolicyViolationError
  │
  ├─ checkContent(prompt)     ← pre-model 内容安全（异步）
  │   └─ 不安全 → 记录 PolicyDenied 事件 → 抛 PolicyViolationError
  │
  ├─ redact(prompt)           ← PII 脱敏（同步）
  │
  ├─ model.complete()         ← 调 LLM
  │
  ├─ checkOutput(response)    ← post-model 输出安全（异步）
  │   └─ 不安全 → 记录 PolicyDenied 事件 → 抛 PolicyViolationError
  │
  └─ record ModelCalled       ← 写入事件日志
```

每次拒绝都记录为 `PolicyDenied` 事件（带机器可读的 `code`），因此所有护栏动作都是可观测、可审计、可 eval 测试的。

### 工业级策略中常见的但本项目尚未实现的能力

| 能力 | 说明 | 成熟方案 |
|------|------|---------|
| **Groundedness 检测** | 验证 LLM 响应是否基于提供的文档（而非幻觉） | Azure Groundedness Detection |
| **受保护材料检测** | 检测响应是否包含受版权保护的文本 | Azure Protected Material Detection |
| **人机审批 (HITL)** | 高风险操作暂停等待人类批准（而非直接拒绝） | `requireApproval: true` 配置 + 审批队列 |
| **动态/上下文感知策略** | 基于 role、phase、content 决定是否允许 | 将静态 `allowedTools` 扩展为 `(ctx) => boolean` |
| **速率限制** | 限制每个工具的调用频率 | `rateLimit: "100/min"` |
| **JSON schema 输出校验** | 验证模型输出是否符合预期结构 | Zod / Pydantic validation |

### Policy 设计原则

1. **Policy 是数据，不是代码**：配置来自 `agent.config.json`，不散落在各个 server/handler 里
2. **Provider 可插拔**：`ContentSafetyProvider` 遵循与 `ModelProvider`、`ResponseCache` 相同的注入模式
3. **拒绝可观测**：每次拦截都记录 `PolicyDenied` 事件（含 `code` + `reason`），可通过 trace/eval 回溯
4. **默认放行**：未配置策略时所有操作允许，NoOpContentSafety 全部通过——渐进式采用
