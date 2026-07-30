/**
 * Public library surface for external hosts (e.g. @agent/coding-agent).
 * Demo CLI / issue workload stay under ./app and are not re-exported here.
 */

export { Runtime, type RuntimeOptions } from './runtime.js';
export type { StepContext, WorkflowDef, StepDef, PhaseDef, CallOptions } from './workflow.js';
export { ToolRegistry, type ToolDef } from './tools/registry.js';
export { PolicyEnforcer, type Policy, type RateLimitRule, resolveRedactions } from './policy.js';
export { DEFAULT_PRICING, type ModelPricing } from './pricing.js';
export type { ModelProvider, ModelResult } from './model/provider.js';
export { MockModelProvider, estimateTokens } from './model/provider.js';
export type { ChatModelProvider, ChatModelRequest, ChatResponseEnvelope } from './model/chat-provider.js';
export {
  encodeChatPrompt,
  encodeChatResponse,
  tryDecodeChatResponse,
} from './model/chat-provider.js';
export type { AgentEvent, RunState, RunInput, RunStatus } from './types.js';
export { createHarnessWorkflow, RuntimeChatModel, RuntimeToolInvoker } from './app/harness-adapter.js';
export type { HarnessWorkflowOptions, HarnessAgentOptions } from './app/harness-adapter.js';
export { ConflictError, EventLog, listRunIds, runDir, type EventLogOptions } from './eventlog.js';
export { extractAnswer, extractHarnessMessages } from './run-state.js';
export { buildTrace, renderTimeline, type Trace, type TraceTotals } from './trace.js';
export {
  SessionManager,
  createConversationSummarizer,
  type SessionManifest,
  type SessionState,
  type ContinueResult,
  type SessionManagerOptions,
  type HistoryMode,
  type ConversationSummarizer,
} from './session.js';
