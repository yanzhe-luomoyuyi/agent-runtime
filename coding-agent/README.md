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

- **Reset fixture**：仅对内置 sandbox 可用；恢复带 bug 的 `session.js`
- **Repository path**：可填任意本地仓库绝对路径（沙箱内读写）；点 Sandbox 回到内置 fixture
- UI 内写文件自动批准（无需 stdin）
- 右上角展示当前 **model** 与 **max prompt tokens**（`min(modelWindow, softCap)`；`DEEPSEEK_MODEL` / `AGENT_MAX_PROMPT_TOKENS`）
- **Trace** 页：runtime 时间线（token / cost / duration / content-cache / replay）+ harness 按 turn（retries / provider cached tokens / assemble·compact）
- Q&A 只看 **Answer**；`ANALYSIS.md` 用于改代码后的文档，或用户点名写某个文件

### 离通用 coding agent 还有多远？

| 已有 | 还缺（对标 Claude Code 一类） |
| --- | --- |
| 任意 `workspace`（CLI `--workspace` / UI / env）+ 路径沙箱 | `apply_patch`、终端命令白名单扩展、git status/diff/commit |
| `.gitignore` 感知 walk / UI diff | 嵌套 `.gitignore`、更完整的大仓索引 |
| 读/写/grep/测 + Analysis/Diff UI | 权限分级、流式 token 输出 |
| DeepSeek + durable resume | 统一配置文件（`docs/TODO.md` §2） |

## CLI

```bash
npm test -w @agent/coding-agent
DEEPSEEK_API_KEY=... AGENT_AUTO_APPROVE=1 npm run dev -w @agent/coding-agent -- "<goal>"
npm run dev -w @agent/coding-agent -- --workspace /path/to/repo "<goal>"
```