# Agent 项目面试口播文档

> 面向 `agent-harness` + `durable-agent-runtime` 的口述稿。  
> 建议时长：开场 2–3 分钟；深度/难点各 2–3 分钟；质疑应对按追问使用。  
> 口播原则：**先讲取舍，再讲实现；少背模块名，多讲「解决了什么问题」**。

---

## 一、开场：两个项目的总体介绍

### 1.1 一句话立意（先说这个）

> 「我做的不是一个业务 Agent，而是 Agent 的**平台层**。我把生产级 Agent 真正难的地方拆成两块：一块是模型驱动的**大脑循环**（`agent-harness`），一块是可崩溃恢复、幂等、可观测的**执行底座**（`durable-agent-runtime`）。中间只用一份纯类型契约把它们缝起来——大脑不知道谁在托管它，底座也不懂『修 issue』这种业务。」

### 1.2 为什么要拆成两个项目

很多开源 Agent 框架把「怎么想」和「怎么跑稳」揉在一起。我刻意拆开，是因为它们解决的问题不同：

| | agent-harness（大脑） | durable-agent-runtime（底座） |
|---|---|---|
| 核心问题 | 模型每 turn 怎么决策、怎么自愈、怎么管上下文 | 长任务崩溃了怎么恢复、副作用怎么不重复、怎么审计 |
| 状态观 | 无状态循环引擎 | 事件溯源，状态全部派生 |
| 依赖 | 只依赖 `@agent/contracts` | 同样只依赖 contracts；通过薄 adapter 托管 harness |
| 可替换性 | 可挂任何宿主（内存 / 持久化） | 可跑固定工作流，也可托管任意 harness |

口播可接一句：

> 「依赖方向是单向的：两边谁都不依赖对方，只有 adapter 同时认识两边。这保证了大脑保持宿主无关、底座保持 Agent 无关。」

### 1.3 agent-harness：核心 component 与功能

**定位：** 模型驱动的 Agent 循环平台。对比「代码写死 `analyze → locate → propose`」，这里是**模型决定**下一步调工具还是给答案。

**四层架构（A/B/C/D）——开场按层各一句：**

| 层 | 模块 | 口播说法 |
|---|---|---|
| **A 协议** | `protocol/` + `schema/` | 把模型响应解释成「已校验的 tool call」或「最终答案」；非法参数变成结构化错误喂回模型，而不是把进程打崩 |
| **B 恢复** | `recovery/` | 瞬时失败重试、熔断、分级模型降级、死循环检测、Saga 补偿、死信队列——错误路径是一等公民 |
| **C 上下文** | `context/` | 有限 token 窗口里做预算装配、原子 tool-call 淘汰、近期 pin、主动压缩、untrusted 围栏、scratchpad 卸载 |
| **D 控制** | `control/` | 核心 `runAgent` + planner / reflection / sub-agent / human-in-the-loop |

**附加能力（开场点到即可，深度再展开）：**

- **Skills**：playbook 注册；默认 on_demand（catalog + 按需读正文），与 sub-agent 正交、不自动 inherit
- **TraceCollector**：turn / token / 成本 / 上下文决策的现场埋点
- **Durable 契约**：每一步带确定性 `key`（`t{turn}` / `t{turn}:{callId}`），宿主按 key 做幂等重放

### 1.4 durable-agent-runtime：核心 component 与功能

**定位：** 让多阶段 LLM Agent **持久化且可恢复**。灵感来自真实 Copilot-CLI Agent 的「单快照 checkpoint」——我把它重做成事件溯源平台。

**平台核心（口播按「问题 → 模块」说）：**

| Component | 功能 |
|---|---|
| **Event Log + Reducer** | Append-only 事件日志；状态用纯函数 fold 派生，永不直接存状态 |
| **Runtime** | 驱动 phase→step；统一 `callModel` / `callTool` 漏斗；确定性 callId 幂等 |
| **Snapshot** | 周期性派生状态快照加速 resume；损坏则回退全量重放 |
| **Policy** | 声明式护栏：allow-list、成本预算、PII、token-bucket 限流；拒绝记 `PolicyDenied` |
| **MCP base SDK** | JSON-RPC / transport / 共享 token cache；本地工具与远程工具同一注册表 |
| **Memory + Retrieval** | 跨会话记忆（lexical/semantic/hybrid）；文档 RAG（`once` / `once_rewrite` / `capped_agentic`） |
| **Trace + Eval + OTel** | 从事后事件日志派生 span；可组合打分器；可导出 OpenTelemetry |
| **Session** | 多轮对话把多个 run 串成线程（qa-pairs / full-summary） |
| **Harness Adapter** | 在 `StepContext` 上实现 `ChatModel` + `ToolInvoker`，透传 key |

**三种执行模式（体现平台通用性）：**

1. 固定工作流（默认 demo：`analyze → locate → propose`）
2. 内置简化 agent 循环（`AGENT_LOOP=1`）
3. 托管完整 harness（`HARNESS=1`）

### 1.5 开场收束（30 秒）

> 「所以面试里如果你只记住一件事：这套东西的核心不是『会调 LLM』，而是把 Agent 当成**长跑系统**来设计——大脑负责决策与自愈，底座负责崩溃安全与可审计，中间靠一个 `key` 把幂等契约钉死。」

---

## 二、体现项目深度的地方

> 面试官追问「你到底深在哪」时，优先挑 **2–3 个**展开，不要一口气背清单。

### 2.1 缝（Seam）设计：contracts + key 即契约

**深在哪：** 不是「抽个 interface 好看」，而是把持久化语义压进一个字符串约定。

口播：

> 「Harness 每一步生成确定性 key：模型是 `t1`，工具是 `t1:c1`。Adapter 原样转给 runtime。Runtime 用这个 key 当 callId 写事件日志。崩溃恢复时同样的 key 命中日志就重放结果，不重新打模型、不重新执行工具副作用。子 Agent 通过 `keyPrefix` 嵌套，保证全局唯一。整条持久化契约，表面上只是一个 string。」

可加对比：

> 「很多框架要么把 loop 和 storage 绑死，要么恢复粒度只到 phase。我把幂等下沉到每一次 model/tool call。」

### 2.2 上下文工程：正确性优先于启发式

**深在哪：** 不是简单截断 history，而是按 API 合法性与指令优先级设计淘汰策略。

口播要点：

1. **Atomic tool-call 单元**：`assistant(toolCalls)` 与对应 `tool` 结果整组淘汰，绝不拆对——否则 transcript 对模型 API 非法。
2. **近期 pin + 重要性**：最新 user 指令硬钉住，不会被更老的高分 tool error 挤掉；扩窗段才用「错误 > 写入 > 读取」重要性折扣。
3. **Untrusted 围栏**：工具结果 / 检索命中标 `untrusted`，只当数据不当指令——这是 prompt injection 的架构级防御，不是事后正则。
4. **Keyed 主动压缩**：摘要调用也带 durable key，保证 resume 时压缩结果可重放、不漂移。
5. **Scratchpad**：超大工具输出卸载，窗口留指针——比截断更不丢信息。

### 2.3 Recovery 不是「加个 retry」

**深在哪：** 错误路径分层，且和 loop 哲学一致——「错误 → observation → 模型自愈」。

| 能力 | 深度点 |
|---|---|
| `withRetry` | HTTP 分类 + `Retry-After` + full jitter；只重试瞬时失败 |
| `CircuitBreaker` | closed / open / half_open；防止打压已挂服务 |
| `createResilientModel` | 分级模型链 + escalation ladder，零侵入 `ChatModel` |
| `LoopDetector` | 不止单次重复，还能抓 A→B→A→B 序列死循环 |
| Saga 补偿 | LIFO 回滚已提交副作用；**刻意做成 opt-in 装饰器**，不进核心 loop |
| Dead Letter | 耗尽重试才入队；内容寻址去重；可人工 `retryDeadLetter` |

口播金句：

> 「Loop 的哲学是让模型看见错误并自愈；Saga 是另一类问题——已经提交的副作用要回滚。所以补偿不能塞进核心 loop，只能当装饰器挂在外面。」

### 2.4 事件溯源底座：状态是算出来的

**深在哪：** 对照「覆盖 JSON checkpoint」讲清楚失败模式。

| 朴素 checkpoint | 本 runtime |
|---|---|
| 覆盖写，写一半可能损坏 | Append-only，崩溃留下有效前缀 |
| 状态直接存 | 状态由 reducer 纯函数派生 |
| 恢复可能重跑副作用 | 确定性 callId，已完成调用只重放 |
| 只剩最后状态 | 完整有序历史，可审计 / 时间旅行 |

额外深度：

- **分级持久化**：critical 事件同步落盘；relaxed 事件可与下一个 critical 合并写（benchmark ~49% 写减少）——这是在正确性前提下做的性能取舍。
- **崩溃注入窗口**：测试刻意打在「副作用已执行、完成事件未写入」——正是朴素 checkpoint 最容易翻车的窗口。
- **两层缓存正交**：run 内幂等重放（不重复副作用）≠ 跨 run 内容寻址 prompt 缓存（省钱）。

### 2.5 Policy / Eval / Trace 闭环

**深在哪：** 护栏不是「配了就算」，而是可观测、可回归。

口播：

> 「Allow-list、预算、PII 是声明式数据，挂在统一调用通道上。每次拒绝都是 `PolicyDenied` 事件。所以 eval 能断言『预算护栏真的拦住了 runaway agent』，而不是『配置文件里写了个数字』。Trace 从事后日志派生，OTel 导出是另一层——harness 只产出结构化数据，真正的网络 IO 留给 runtime，保持大脑宿主无关。」

Eval 可点到的维度：结果性（完成/触文件）、过程性（turns / trajectory judge）、人机协同（人工介入率）、护栏回归（policy denial）。

### 2.6 Skills ≠ Sub-agent（边界清晰）

口播：

> 「Skill 是教**当前** agent 怎么干的 playbook；sub-agent 是把活**委派**给另一个 agent。默认 skills on_demand，正文按需读，避免开局塞爆 context。父 skills 不自动 inherit 到子 agent——这和 Claude Code 等工业实践一致，也是安全边界：角色污染和上下文膨胀都来自『默认继承一切』。」

### 2.7 可选「深度加分项」（有追问再讲）

- Sub-agent 深度限制用 `AsyncLocalStorage`：跨并发委派链隔离真实嵌套深度，超限变普通 ERROR observation，loop 无需特判。
- Reflection 升级到 L2 结构化诊断（rootCause / correctionStrategy / whatWorked），不是简单 pass/fail 重试。
- Memory 与 Document corpus 刻意分家：短事实 vs 文档 chunk，避免混表。
- Retrieval 三种策略：`once` 默认省算力；`once_rewrite` keyed 改写；`capped_agentic` 硬顶防无限搜。

---

## 三、项目的难点

> 结构建议：每个难点用 **「表面问题 → 真正难点 → 我怎么解 → 取舍」**。

### 难点 1：崩溃恢复与副作用安全（runtime 最硬的核）

**表面问题：** Agent 跑到一半进程挂了，怎么接着跑？

**真正难点：** 不是「存个进度」，而是——工具可能已经改了外部世界，但「成功事件」还没落盘。朴素 checkpoint 若写在副作用前，resume 会重复执行；写在副作用后，崩溃可能丢进度。

**解法：**

- Append-only 事件日志 + 纯 reducer 派生状态
- 每次 model/tool 带确定性 callId；日志已有结果则重放
- 测试在「副作用后、完成事件前」注入崩溃

**取舍：** 整个 harness loop 先做成一个 coarse durable step——靠细粒度 key 保证可恢复；更细的 checkpoint 是演进方向，但复杂度更高。

### 难点 2：大脑与底座解耦，同时还能持久化托管

**表面问题：** 两个包互相 import 不就完了？

**真正难点：** 一旦 harness 依赖 runtime，大脑就不再宿主无关；一旦 runtime 依赖 harness 细节，底座就绑死一种 Agent。还要保证 resume 时模型/工具调用幂等。

**解法：**

- `@agent/contracts` 纯类型缝：`ChatModel` / `ToolInvoker` + `key`
- Adapter 只在 `app/` 层实现两边接口并透传 key
- Skills 静态正文用本地 AugmentedToolInvoker，不污染事件重放

**取舍：** 集成路径变长（多一个 adapter），换来两边可独立演进与测试。

### 难点 3：上下文窗口的正确性陷阱

**表面问题：** token 超了就删旧消息。

**真正难点：**

1. 拆开 tool-call / tool-result → API 非法 transcript  
2. 用「重要性」压掉最新用户指令 → agent 忘掉当前目标  
3. 把工具输出塞进 system → prompt injection  
4. 压缩本身若不可重放 → durable resume 摘要漂移

**解法：** atomic unit、recent pin、untrusted fence、keyed compaction、scratchpad。

**取舍：** 暂缓更花哨的 `score × recencyDecay`——缺 telemetry 前无法证伪，先保证正确性与可观测决策（assemble/compact 决策进 trace）。

### 难点 4：死循环 vs 合法探索

**表面问题：** 模型反复调同一个工具，掐掉就行。

**真正难点：** 单次重复检测假阳性很高——探索阶段本来就会多次 search。真正危险的是**无进展的序列循环**（A→B→A→B）。

**解法：** 滑动窗口 + 序列模式检测 + per-tool 上限；检测到后转 observation 让模型改策略，而不是直接杀进程。

### 难点 5：声明式护栏与事件溯源的边界

**表面问题：** 限流、预算要不要一起事件源化？

**真正难点：** 限流是进程本地、实时保护；若把 bucket 状态写进事件日志，resume 重放会「重新扣额度」，语义错乱。

**解法：** PolicyDenied 入日志（可审计）；token-bucket 故意**不**事件源化，重启重置。预算/allow-list 以数据声明，拒绝可 eval。

### 难点 6：可观测性分层（两套 trace 不是重复造轮）

**表面问题：** 为什么 harness 一套、runtime 又一套？

**真正难点：** harness 要保持 host-agnostic，不能读事件日志、不能发 OTLP；runtime 的价值是「有日志就能重建历史」，包括失败 run / resume。

**解法：**

- Harness `TraceCollector`：现场埋点（turn 决策、上下文装配）
- Runtime `buildTrace`：事后投影（replayHitRate、policy、cache 节省）
- `otel.ts` 单独桥接导出

**取舍：** 两边不自动合并——需要关联时由宿主用 runId/turn 对齐；换来清晰边界。

### 难点 7：工程落地的「假深度」陷阱（可主动承认）

口播里主动说，反而加分：

> 「个人项目最大的难点之一是克制：很容易堆 MemGPT / ToT / 知识图谱这些名词。我强制自己每个模块都回答三个问题——解决什么失败模式、和事件溯源/幂等是否冲突、有没有测试能证伪。所以像自动记忆提炼、语义缓存，我宁可标成刻意不做，也不做看起来很炫但不可控的东西。」

---

## 四、「个人项目为什么值得被认真对待」话术

> 应对：「这只是 toy / 没有真实业务 / 没在生产跑过吧？」  
> 原则：**承认边界，转移评价标准**——从「有没有 DAU」转到「有没有真实工程约束、可证伪设计、可演示失败模式」。

### 4.1 总应答框架（推荐背这一段）

> 「对，它不是线上业务系统，我也没有假装有百万调用。但 Agent 平台层的难点，本来就不主要在『业务 CRUD』，而在崩溃窗口、幂等、上下文正确性、护栏可验证性这些**工程约束**。我的评价标准不是有没有真实用户，而是：  
> 1）是否对准了生产 Agent 真实会翻车的失败模式；  
> 2）设计决策能不能被测试证伪；  
> 3）边界和取舍是否写清楚，而不是把 demo 工作负载和平台揉在一起。  
> 从这个标准看，这个项目是在练**平台工程判断力**，不是练调 prompt。」

### 4.2 分镜应答（按质疑类型选）

#### 质疑 A：「没有实际业务场景」

> 「业务场景我故意做薄——`issue → fix` 只是可替换的 workload。平台代码不认识『issue』。真实灵感来自 Copilot-CLI 类 Agent 的跨会话 checkpoint 问题：单快照覆盖写会坏在崩溃窗口。我把那个问题抽象成事件溯源 + 幂等 callId。所以场景不是『帮公司修登录页』，而是『长跑 Agent 如何崩溃安全』——这本身就是平台业务。」

#### 质疑 B：「没用真模型 / 没跑过生产」

> 「开发期我刻意用确定性 mock 模型，原因有三个：一是崩溃恢复和幂等测试必须可复现，真模型会让 CI flaky；二是 eval 回归要能稳定 fail（我甚至有 `AGENT_REGRESS=1` 故意降级输出验证框架能抓住回归）；三是 provider 是注入的，接真模型是 adapter 工作，不是架构缺口。  
> 另外崩溃恢复、policy denial、MCP 路径、harness 托管，都可以用 CLI 当场演示——这不是 PPT 架构。」

可补一句演示锚点：

> 「比如 `CRASH_AFTER=locate.1` 强制崩，再 `resume`：已成功的 `searchCode` 不会重跑。这就是我对『跑过』的定义——关键失败路径被演过、被测过。」

#### 质疑 C：「不就是仿 LangGraph / 开源框架吗？」

> 「我不是从零发明 Agent，而是针对朴素 checkpoint 和『大脑/底座耦死』做减法重做。和现成框架比，我强调三件事：  
> 1）contracts 缝 + key 契约让 harness 可被任意宿主持久化托管；  
> 2）上下文淘汰按 atomic unit + recent pin，先保 API/目标正确性；  
> 3）policy/eval 能验证护栏生效，而不是配置摆设。  
> 面试官如果问差距，我也能直接说：middleware 管道、子 agent 并行、L4 工具验证反思等我还没做——我清楚边界。」

#### 质疑 D：「个人项目含金量不如实习业务」

> 「业务实习证明我能在存量系统里交付；这个项目证明我能在**没有现成脚手架**时，自己识别平台问题、做分层、写可恢复运行时，并用测试钉住不变量。两者测的能力不同。如果团队在做 Agent 基础设施、可靠性、可观测或评测，这个项目的迁移成本其实更低——因为问题同构。」

#### 质疑 E：「代码量很多，是不是 AI 生成堆出来的？」

> 「模块多，但主线很窄：contracts → harness A/B/C/D → runtime event sourcing → adapter 透传 key。你可以按这条线问任意深度：为什么 Saga 不进 loop、为什么限流不事件源化、为什么 skills 不 inherit——这些是设计题，不是补全题。我也能指出刻意没做的部分，说明不是无脑堆 feature。」

### 4.3 主动亮「可迁移产出」（把个人项目翻译成团队价值）

面试末尾可收束：

> 「如果我加入你们做 Agent 平台，我能立刻贡献的不是某个业务 prompt，而是这几类判断：  
> - 持久化粒度选在哪一层（phase vs 每次 tool call）  
> - 哪些状态该事件源化，哪些不该  
> - 上下文淘汰如何避免拆对与目标丢失  
> - 护栏如何变成可 eval 的不变量  
> - 如何用确定性测试锁住崩溃窗口  
> 这些判断不依赖我有没有线上流量，依赖的是我有没有把失败模式想清楚。」

### 4.4 语气红线（避免减分）

| 少说 | 改说 |
|---|---|
| 「已经生产可用 / 对标某某大厂」 | 「对准了生产级失败模式，并用测试/演示锁住」 |
| 「功能比 LangChain 全」 | 「在 seam、幂等、上下文正确性上做了更硬的取舍」 |
| 「完全没缺点」 | 「明确差距：并行子 agent、middleware、L4 验证反思等」 |
| 「业务不重要」 | 「业务 workload 刻意可替换；平台问题才是本题」 |

---

## 五、推荐口述节奏（约 8–10 分钟版）

1. **立意 + 拆分**（1 min）：大脑 / 底座 / contracts 缝  
2. **Harness 四层各一句**（1.5 min）  
3. **Runtime 事件溯源 + 幂等 key**（1.5 min）  
4. **深度挑 2 个**：上下文正确性 + 崩溃窗口（2 min）  
5. **难点挑 2 个**：解耦托管 + 死循环/护栏边界（2 min）  
6. **收束**：个人项目的评价标准 + 可迁移判断力（1 min）  
7. 留时间给追问；质疑类话术按需启用

### 30 秒电梯稿（被打断时用）

> 「我做了一个 Agent 平台 monorepo：`agent-harness` 是运行时无关的模型循环，解决协议校验、自愈、上下文和规划/反思/子代理；`durable-agent-runtime` 是事件溯源执行底座，解决崩溃恢复、幂等工具调用、声明式护栏和可观测评测。两者通过纯类型契约和确定性 key 连接。项目深度不在业务 demo，而在把生产 Agent 最容易翻车的可靠性问题做成可测试的平台不变量。」

---

## 六、高频追问速查（短答）

| 问题 | 短答 |
|---|---|
| 为什么不用单快照 checkpoint？ | 覆盖写有损坏与副作用重复两类失败；事件前缀 + 幂等 callId 同时解 |
| 为什么整段 harness 是一个 durable step？ | 粗但简单；细粒度靠 key 幂等；更细 checkpoint 是演进 |
| key 冲突怎么办？ | 约定确定性生成；子 agent 用 keyPrefix；runtime 同 callId 命中则重放 |
| 和 LangGraph 差在哪？ | 我更偏「可托管大脑 + 事件溯源底座」的 seam；不是通用 StateGraph |
| 如何证明护栏有效？ | `PolicyDenied` 入日志 + eval 场景断言拒绝发生 |
| 真接 OpenAI 要改啥？ | 实现 `ModelProvider` / `ChatModel`；loop 与 runtime 不改 |
| 最大技术风险？ | 压缩/摘要质量、mock 与真模型分布差、coarse step 下的长循环观测粒度 |
| 下一步做什么？ | 真 provider adapter、更细 checkpoint、工具验证型 reflection（L4）、子 agent 并行 |

---

*文档对应仓库：`agent-harness`、`durable-agent-runtime`（及缝 `agent-contracts`）。细节以各包 README 与 `docs/agent-architecture-notes-full.md` 为准。*
