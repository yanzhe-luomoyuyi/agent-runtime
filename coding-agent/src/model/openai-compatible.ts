/**
 * OpenAI-compatible Chat Completions client.
 * Defaults target DeepSeek (`https://api.deepseek.com` + DEEPSEEK_API_KEY).
 */

import type { ChatResponse, Message, StopReason, ToolCall, ToolSpec, Usage } from '@agent/contracts';
import type { ChatModelProvider, ChatModelRequest } from 'durable-agent-runtime';

export interface OpenAICompatibleOptions {
  apiKey: string;
  /** Default: DeepSeek. */
  baseUrl?: string;
  /** Default: deepseek-chat. */
  model?: string;
  fetchImpl?: typeof fetch;
  name?: string;
}

const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

export interface ChatProviderEnvOptions {
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  apiKeyEnvFallbacks?: string[];
  baseUrlEnv?: string;
  modelEnv?: string;
  providerName?: string;
}

export function createOpenAICompatibleChatProvider(opts: OpenAICompatibleOptions): ChatModelProvider {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  const model = opts.model ?? DEFAULT_MODEL;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const name = opts.name ?? `openai-compatible:${model}`;

  return {
    name,
    async chat(req: ChatModelRequest): Promise<ChatResponse> {
      const body: Record<string, unknown> = {
        model,
        messages: req.messages.map(toApiMessage),
      };
      if (!req.textCompletion && req.tools.length > 0) {
        body.tools = req.tools.map(toApiTool);
      }

      const url = `${baseUrl}/chat/completions`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`LLM HTTP ${res.status}: ${errText.slice(0, 500)}`);
      }
      const data = (await res.json()) as ApiChatCompletion;
      return fromApiCompletion(data);
    },
  };
}

/** Resolve provider from env, with optional defaults from agent.config.json. */
export function chatProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  defaults: ChatProviderEnvOptions = {},
): ChatModelProvider | undefined {
  const keyEnvs = [defaults.apiKeyEnv ?? 'DEEPSEEK_API_KEY', ...(defaults.apiKeyEnvFallbacks ?? ['LLM_API_KEY'])];
  let apiKey: string | undefined;
  for (const name of keyEnvs) {
    if (env[name]) {
      apiKey = env[name];
      break;
    }
  }
  if (!apiKey) return undefined;

  const baseUrlEnv = defaults.baseUrlEnv ?? 'DEEPSEEK_BASE_URL';
  const modelEnv = defaults.modelEnv ?? 'DEEPSEEK_MODEL';
  return createOpenAICompatibleChatProvider({
    apiKey,
    baseUrl: env[baseUrlEnv] ?? env.LLM_BASE_URL ?? defaults.baseUrl ?? DEFAULT_BASE,
    model: env[modelEnv] ?? env.LLM_MODEL ?? defaults.model ?? DEFAULT_MODEL,
    name: defaults.providerName ?? 'deepseek',
  });
}

// ── wire format ─────────────────────────────────────────────────────

interface ApiChatCompletion {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toApiMessage(m: Message): Record<string, unknown> {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.toolCallId,
      content: m.content ?? '',
      name: m.name,
    };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content ?? null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: {
          name: c.name,
          arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}),
        },
      })),
    };
  }
  return { role: m.role, content: m.content ?? '' };
}

function toApiTool(t: ToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  };
}

function fromApiCompletion(data: ApiChatCompletion): ChatResponse {
  const choice = data.choices?.[0];
  const msg = choice?.message;
  const usage: Usage = {
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
  const thinking = msg?.reasoning_content?.trim() || undefined;
  const toolCalls = (msg?.tool_calls ?? [])
    .map((tc): ToolCall | undefined => {
      const name = tc.function?.name;
      if (!name) return undefined;
      let args: unknown = {};
      const raw = tc.function?.arguments ?? '{}';
      try {
        args = JSON.parse(raw);
      } catch {
        args = { _raw: raw };
      }
      return { id: tc.id, name, arguments: args };
    })
    .filter((x): x is ToolCall => Boolean(x));

  const stopReason = mapFinishReason(choice?.finish_reason, toolCalls.length > 0);
  const content = msg?.content ?? undefined;
  const message: Message = {
    role: 'assistant',
    content: content || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    thinking,
  };
  return { message, stopReason, usage, thinking };
}

function mapFinishReason(reason: string | null | undefined, hasTools: boolean): StopReason {
  if (hasTools || reason === 'tool_calls') return 'tool_calls';
  if (reason === 'length') return 'length';
  if (reason === 'content_filter') return 'refusal';
  return 'stop';
}
