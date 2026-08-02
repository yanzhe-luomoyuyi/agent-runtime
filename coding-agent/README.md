# `@agent/coding-agent`

沙箱 Coding Agent（分析 → 改代码 → 写文档），宿主为 `durable-agent-runtime` + `@agent/harness`，默认 LLM 为 DeepSeek。

**接手 / 设计说明：** [docs/dev-design.md](docs/dev-design.md)

## Workbench UI（推荐）

本地可视化界面：输入 goal、看实时工具日志、**Analysis**、**Code diff**。

把 key 写进 **gitignore 的** `coding-agent/.env`（可复制 `.env.example`）：

```bash
# coding-agent/.env
DEEPSEEK_API_KEY=sk-...
```

然后：

```bash
npm run ui -w @agent/coding-agent
# 浏览器打开 http://127.0.0.1:8787
```

- **Repository path**：填本地仓库绝对路径（沙箱内读写）
- UI 内写文件自动批准（无需 stdin）
- 右上角展示当前 **model** 与 **max prompt tokens**（`min(modelWindow, softCap)`；`DEEPSEEK_MODEL` / `AGENT_MAX_PROMPT_TOKENS`）
- **Trace** 页：runtime 时间线（token / cost / duration / provider prompt-cache / replay）+ harness 按 turn（retries / provider cached tokens / assemble·compact）
- Q&A 只看 **Answer**；`ANALYSIS.md` 用于改代码后的文档，或用户点名写某个文件

### 离通用 coding agent 还有多远？

| 已有 | 还缺（对标 Claude Code 一类） |
| --- | --- |
| 任意 `workspace`（CLI `--workspace` / UI / env）+ 路径沙箱 | `apply_patch`、终端命令白名单扩展、git status/diff/commit |
| `.gitignore` 感知 walk / UI diff | 嵌套 `.gitignore`、更完整的大仓索引 |
| 读/写/grep/测 + Analysis/Diff UI | 权限分级、流式 token 输出 |
| DeepSeek + durable resume | Workbench Session / crash / resume / pause / HITL（`docs/TODO.md` §3） |

## 配置（`agent.config.json`）

可调默认值集中在包根 [`agent.config.json`](./agent.config.json)（加载器：`src/config.ts`）：人设 / skill、模型、workspace、工具限额、`maxTurns`、compaction、policy、pricing。环境变量（`DEEPSEEK_*` / `AGENT_*`）覆盖文件；调用方参数再覆盖。可用 `AGENT_CONFIG` 指向另一份 JSON。

- **死信队列**（`run.deadLetter`，默认 `enabled: true`）——工具调用耗尽重试后仍失败，内容寻址记录到 `run.deadLetter.storeDir`（默认 `.coding-agent-dead-letters/queue.json`），供人工复盘/`retryDeadLetter()` 重放；只记录不阻断，`CodingRuntimeOptions.deadLetter` 可按次覆盖。
- **按工具限流**（`policy.rateLimits`，默认空/不限）——token-bucket，格式同 `durable-agent-runtime` 的 `RateLimitRule`（`{ capacity, refillPerSec }`），按需在 `agent.config.json` 里显式加。
- **循环检测调优**（`run.loop`，默认已按编码画像）——透传 harness `LoopDetector`：`windowSize`（默认 16）、`toolLimits`（读/验证工具 6–8、写工具 2–3）、`sequenceMutatingTools`（默认写工具集合——`write→test` 仍检测、`grep→read` 不误报）、`successResets`（默认 `run_tests`/`run_check`——绿测=进展重置计数，连红才累积）、`advisoryTools`（默认只读/验证工具——触发时轻推模型换思路、run 继续，写工具保持硬中止）。`CodingRuntimeOptions.loopOptions` 可按次覆盖。

## CLI

```bash
npm test -w @agent/coding-agent
DEEPSEEK_API_KEY=... AGENT_AUTO_APPROVE=1 npm run dev -w @agent/coding-agent -- "<goal>"
npm run dev -w @agent/coding-agent -- --workspace /path/to/repo "<goal>"
```

## Eval

```bash
npm run dev -w @agent/coding-agent -- eval                      # 脚本化模型，无网络，全过
AGENT_EVAL_REGRESS=1 npm run dev -w @agent/coding-agent -- eval # 演示回归被抓住，退出码 1
AGENT_EVAL_LIVE=1 npm run dev -w @agent/coding-agent -- eval    # 真实模型（DEEPSEEK_API_KEY），测真实能力，非 CI 默认
```

两个真实、零依赖的 bug fixture（`src/eval/fixtures.ts`）+ 一个成本预算护栏场景（`src/eval/scenarios.ts`）。核心是**客观标准**：`testsPass()` 打分器读 agent 自己调用 `run_tests` 的真实结果（`{ ok, exitCode }`），不是字符串匹配最终答案——`AGENT_EVAL_REGRESS=1` 会换上一个瞎猜、不读文件就改的脚本，`str_replace` 直接报错，`run_tests` 永远不会被叫到，`testsPass()` 如实报 `run_tests was never called`。`AGENT_EVAL_LIVE=1` 换掉脚本化模型，接真实 DeepSeek 跑同一批 bug fixture（`liveCodingScenarios`，回合/预算阈值放宽），检验的是提示词/skill 真实能力有没有退化，而不只是框架接线有没有断——需要联网 + 花钱 + 结果非确定性，因此从不进默认测试套件。详见 [docs/observability-trace-and-eval.md](../docs/observability-trace-and-eval.md)（§4.6）。