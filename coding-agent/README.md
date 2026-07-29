# `@agent/coding-agent`

沙箱 Coding Agent（分析 → 改代码 → 写文档），宿主为 `durable-agent-runtime` + `@agent/harness`，默认 LLM 为 DeepSeek。

**接手 / 设计说明：** 见 [docs/dev-design.md](docs/dev-design.md)（目标、架构、`callChat`、模块地图、环境变量、已完成与下一步）。

```bash
npm test -w @agent/coding-agent
DEEPSEEK_API_KEY=... AGENT_AUTO_APPROVE=1 npm run dev -w @agent/coding-agent -- "<goal>"
```
