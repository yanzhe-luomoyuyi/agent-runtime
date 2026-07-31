/**
 * Thin ChatModelProvider adapter over harness `createResilientModel`.
 * Escalation (including chatStream) lives in the harness; this only bridges
 * the runtime provider seam ↔ contracts ChatModel.
 */

import type { ChatModel } from '@agent/contracts';
import { createResilientModel, type RetryOptions, type CircuitBreakerOptions, CircuitBreaker } from '@agent/harness';
import type { ChatModelProvider, ChatModelRequest } from 'durable-agent-runtime';

export interface ChatProviderTier {
  provider: ChatModelProvider;
  retry?: RetryOptions;
  breaker?: CircuitBreaker | CircuitBreakerOptions | false;
}

export interface ResilientChatProviderOptions {
  tiers: ChatProviderTier[];
  onEscalate?(info: { from: string; to: string; index: number; error: unknown }): void;
  isFatal?(err: unknown): boolean;
  name?: string;
}

/** Adapt a runtime ChatModelProvider to the harness ChatModel seam. */
export function providerAsChatModel(provider: ChatModelProvider): ChatModel {
  return {
    name: provider.name,
    chat: (req) => provider.chat(req),
    chatStream: provider.chatStream ? (req) => provider.chatStream!(req) : undefined,
  };
}

/**
 * Try each provider tier in order until one succeeds — delegates entirely to
 * harness `createResilientModel` (batch + stream).
 */
export function createResilientChatProvider(opts: ResilientChatProviderOptions): ChatModelProvider {
  if (opts.tiers.length === 0) {
    throw new Error('createResilientChatProvider: at least one tier is required');
  }

  const resilient = createResilientModel({
    tiers: opts.tiers.map((t) => ({
      model: providerAsChatModel(t.provider),
      retry: t.retry,
      breaker: t.breaker,
    })),
    onEscalate: opts.onEscalate,
    isFatal: opts.isFatal,
    name: opts.name,
  });

  return {
    name: resilient.name,
    chat: (req: ChatModelRequest) => resilient.chat(req),
    chatStream: (req: ChatModelRequest) => resilient.chatStream!(req),
  };
}
