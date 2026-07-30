/**
 * StepContext factory — the durable callModel / callChat / callTool funnel.
 *
 * Kept out of Runtime so the orchestrator stays about phases/events/snapshots,
 * while idempotency + policy + provider I/O for a single step live here.
 */

import type { ChatResponse, ChatStreamOutput } from '@agent/contracts';
import { runtimeModelCallId, runtimeToolCallId } from '@agent/contracts';

import {
  accumulateChatStream,
  chatResponseToStream,
  encodeChatPrompt,
  encodeChatResponse,
  tryDecodeChatResponse,
  type ChatModelProvider,
  type ChatModelRequest,
} from './model/chat-provider.js';
import type { ModelProvider } from './model/provider.js';
import type { PolicyEnforcer } from './policy.js';
import {
  enforceBudget,
  enforceContentSafety,
  enforceOutputSafety,
  enforceRateLimit,
  enforceToolAllowed,
} from './policy/enforcement.js';
import { DEFAULT_PRICING, estimateModelCost, type ModelPricing } from './pricing.js';
import type { ToolRegistry } from './tools/registry.js';
import type { AgentEvent, RunState, StreamNotifyEvent } from './types.js';
import type { CallOptions, StepContext } from './workflow.js';

export interface StepContextDeps {
  runId: string;
  issue: string;
  tools: ToolRegistry;
  model?: ModelProvider;
  chatModel?: ChatModelProvider;
  policy?: PolicyEnforcer;
  pricing?: ModelPricing;
  record: (event: AgentEvent) => void;
  getState: () => RunState;
  getSpentUsd: () => number;
  /** Invoked after a tool failure is logged (e.g. dead-letter enqueue). */
  onToolFailure?: (tool: string, args: unknown, error: string, callId: string) => Promise<void>;
  /** Live-only token notify — not persisted. */
  onStreamEvent?: (event: StreamNotifyEvent) => void;
}

/** Build the StepContext the workflow steps see. */
export function createStepContext(deps: StepContextDeps): StepContext {
  const ctx: StepContext = {
    runId: deps.runId,
    input: { issue: deps.issue, conversationHistory: deps.getState().input?.conversationHistory },
    get state() {
      return deps.getState();
    },
    tools: deps.tools,
    getStepOutput: <R>(stepId: string): R | undefined => deps.getState().stepOutputs[stepId] as R | undefined,
    emit: (event) => {
      deps.record(event);
    },
    callModel: (prompt, opts) => callModel(deps, prompt, opts),
    callTool: (tool, args, opts) => callTool(deps, tool, args, opts),
  };

  if (deps.onStreamEvent) {
    ctx.notifyStream = deps.onStreamEvent;
  }

  if (deps.chatModel) {
    ctx.callChat = (req, opts) => callChat(deps, req, opts);
    ctx.callChatStream = (req, opts) => callChatStream(deps, req, opts);
  }

  return ctx;
}

async function callModel(deps: StepContextDeps, prompt: string, opts?: CallOptions): Promise<string> {
  const state = deps.getState();
  const callId = runtimeModelCallId(state.currentPhase!, state.currentStep!, opts?.key);
  if (callId in state.modelResults) return state.modelResults[callId]!;

  if (!deps.model) {
    throw new Error('callModel: Runtime was constructed without a text ModelProvider');
  }

  enforceBudget(deps.policy, deps.getSpentUsd(), callId, deps.record);

  // Check raw prompt before redaction so injections cannot hide behind markers.
  if (deps.policy) {
    await enforceContentSafety(deps.policy, prompt, callId, deps.record);
  }

  const outbound = deps.policy ? deps.policy.redact(prompt).text : prompt;

  const startedAt = Date.now();
  const { text, promptTokens, completionTokens, cachedPromptTokens } = await deps.model.complete(outbound);
  const costUsd = costOf(deps.pricing, promptTokens, completionTokens, cachedPromptTokens);

  if (deps.policy) {
    await enforceOutputSafety(deps.policy, text, callId, deps.record);
  }

  deps.record({
    type: 'ModelCalled',
    callId,
    phase: state.currentPhase!,
    step: state.currentStep!,
    prompt: outbound,
    response: text,
    promptTokens,
    completionTokens,
    cachedPromptTokens,
    costUsd,
    latencyMs: Date.now() - startedAt,
    ts: nowIso(),
  });
  return text;
}

async function callChat(
  deps: StepContextDeps,
  req: ChatModelRequest,
  opts?: CallOptions,
): Promise<ChatResponse> {
  const state = deps.getState();
  const callId = runtimeModelCallId(state.currentPhase!, state.currentStep!, opts?.key);
  if (callId in state.modelResults) {
    const decoded = tryDecodeChatResponse(state.modelResults[callId]!);
    if (!decoded) {
      throw new Error(`callChat: stored result for ${callId} is not a chat envelope`);
    }
    return decoded;
  }

  const chatModel = deps.chatModel;
  if (!chatModel) {
    throw new Error('callChat: Runtime was constructed without a ChatModelProvider');
  }

  enforceBudget(deps.policy, deps.getSpentUsd(), callId, deps.record);

  const promptAudit = encodeChatPrompt(req);
  if (deps.policy) {
    await enforceContentSafety(deps.policy, promptAudit, callId, deps.record);
  }

  const startedAt = Date.now();
  const response = await chatModel.chat(req);
  const { promptTokens, completionTokens, cachedPromptTokens } = response.usage;
  const costUsd = costOf(deps.pricing, promptTokens, completionTokens, cachedPromptTokens);
  const encoded = encodeChatResponse(response);

  if (deps.policy) {
    await enforceOutputSafety(deps.policy, encoded, callId, deps.record);
  }

  deps.record({
    type: 'ModelCalled',
    callId,
    phase: state.currentPhase!,
    step: state.currentStep!,
    prompt: promptAudit,
    response: encoded,
    promptTokens,
    completionTokens,
    cachedPromptTokens,
    costUsd,
    latencyMs: Date.now() - startedAt,
    ts: nowIso(),
  });
  return response;
}

/**
 * Stream a chat turn. On resume, synthesises chunks from the stored envelope.
 * Live path records one final ModelCalled after the stream completes (same as callChat).
 */
async function* callChatStream(
  deps: StepContextDeps,
  req: ChatModelRequest,
  opts?: CallOptions,
): AsyncIterable<ChatStreamOutput> {
  const state = deps.getState();
  const callId = runtimeModelCallId(state.currentPhase!, state.currentStep!, opts?.key);
  if (callId in state.modelResults) {
    const decoded = tryDecodeChatResponse(state.modelResults[callId]!);
    if (!decoded) {
      throw new Error(`callChatStream: stored result for ${callId} is not a chat envelope`);
    }
    yield* chatResponseToStream(decoded);
    return;
  }

  const chatModel = deps.chatModel;
  if (!chatModel) {
    throw new Error('callChatStream: Runtime was constructed without a ChatModelProvider');
  }

  enforceBudget(deps.policy, deps.getSpentUsd(), callId, deps.record);

  const promptAudit = encodeChatPrompt(req);
  if (deps.policy) {
    await enforceContentSafety(deps.policy, promptAudit, callId, deps.record);
  }

  const startedAt = Date.now();
  const chunks: ChatStreamOutput[] = [];

  if (chatModel.chatStream) {
    for await (const chunk of chatModel.chatStream(req)) {
      chunks.push(chunk);
      yield chunk;
    }
  } else {
    const response = await chatModel.chat(req);
    for await (const chunk of chatResponseToStream(response)) {
      chunks.push(chunk);
      yield chunk;
    }
  }

  const response = accumulateChatStream(chunks);
  const { promptTokens, completionTokens, cachedPromptTokens } = response.usage;
  const costUsd = costOf(deps.pricing, promptTokens, completionTokens, cachedPromptTokens);
  const encoded = encodeChatResponse(response);

  if (deps.policy) {
    await enforceOutputSafety(deps.policy, encoded, callId, deps.record);
  }

  deps.record({
    type: 'ModelCalled',
    callId,
    phase: state.currentPhase!,
    step: state.currentStep!,
    prompt: promptAudit,
    response: encoded,
    promptTokens,
    completionTokens,
    cachedPromptTokens,
    costUsd,
    latencyMs: Date.now() - startedAt,
    ts: nowIso(),
  });
}

async function callTool<R>(
  deps: StepContextDeps,
  tool: string,
  args: unknown,
  opts?: CallOptions,
): Promise<R> {
  const state = deps.getState();
  const callId = runtimeToolCallId(state.currentPhase!, state.currentStep!, tool, opts?.key);
  if (callId in state.toolResults) return state.toolResults[callId] as R;

  // Allow-list first (cheap/static); rate limit only once the tool is permitted.
  enforceToolAllowed(deps.policy, tool, deps.record);
  enforceRateLimit(deps.policy, tool, deps.record);

  deps.record({ type: 'ToolCallRequested', callId, tool, args, ts: nowIso() });
  try {
    const result = await deps.tools.get(tool).run(args);
    deps.record({ type: 'ToolCallSucceeded', callId, tool, result, ts: nowIso() });
    return result as R;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    deps.record({ type: 'ToolCallFailed', callId, tool, error: message, ts: nowIso() });
    if (deps.onToolFailure) {
      await deps.onToolFailure(tool, args, message, callId);
    }
    throw e;
  }
}

function costOf(
  pricing: ModelPricing | undefined,
  promptTokens: number,
  completionTokens: number,
  cachedPromptTokens?: number,
): number {
  return estimateModelCost(pricing ?? DEFAULT_PRICING, promptTokens, completionTokens, cachedPromptTokens ?? 0);
}

function nowIso(): string {
  return new Date().toISOString();
}
