/**
 * OpenAI-compatible Chat Completions client.
 * Defaults target DeepSeek (`https://api.deepseek.com` + DEEPSEEK_API_KEY).
 * Supports batch `chat` and SSE `chatStream` (`stream: true`).
 */

import type {
  ChatResponse,
  ChatStreamOutput,
  Message,
  StopReason,
  ToolCall,
  ToolSpec,
  Usage,
} from '@agent/contracts';
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
      const body = buildRequestBody(model, req, false);
      const data = (await postJson(fetchImpl, baseUrl, opts.apiKey, body)) as ApiChatCompletion;
      return fromApiCompletion(data);
    },
    async *chatStream(req: ChatModelRequest): AsyncIterable<ChatStreamOutput> {
      const body = buildRequestBody(model, req, true);
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`LLM HTTP ${res.status}: ${errText.slice(0, 500)}`);
      }
      if (!res.body) {
        throw new Error('LLM stream: response body is null');
      }
      yield* parseOpenAIChatStream(res.body);
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
  for (const envName of keyEnvs) {
    if (env[envName]) {
      apiKey = env[envName];
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

/** Parse OpenAI-compatible SSE body into ChatStreamOutput chunks. Exported for tests. */
export async function* parseOpenAIChatStream(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterable<ChatStreamOutput> {
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
  let stopReason: StopReason = 'stop';
  let usage: Usage = { promptTokens: 0, completionTokens: 0 };
  let sawToolCall = false;

  for await (const line of iterateSseDataLines(body)) {
    if (line === '[DONE]') break;
    let data: ApiStreamChunk;
    try {
      data = JSON.parse(line) as ApiStreamChunk;
    } catch {
      continue;
    }

    if (data.usage) {
      usage = {
        promptTokens: data.usage.prompt_tokens ?? usage.promptTokens,
        completionTokens: data.usage.completion_tokens ?? usage.completionTokens,
      };
    }

    const choice = data.choices?.[0];
    if (!choice) continue;

    if (choice.finish_reason) {
      stopReason = mapFinishReason(choice.finish_reason, sawToolCall || toolAcc.size > 0);
    }

    const delta = choice.delta;
    if (!delta) continue;

    if (delta.reasoning_content) {
      yield { thinking: delta.reasoning_content };
    }
    // Some OpenAI-compatible reasoners use `reasoning` instead of `reasoning_content`.
    if (delta.reasoning && !delta.reasoning_content) {
      yield { thinking: delta.reasoning };
    }
    if (delta.content) {
      yield { content: delta.content };
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let acc = toolAcc.get(idx);
        if (!acc) {
          acc = { id: tc.id ?? `tool_${idx}`, name: '', arguments: '' };
          toolAcc.set(idx, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        sawToolCall = true;
      }
    }
  }

  for (const [, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!acc.name) continue;
    let args: unknown = {};
    try {
      args = JSON.parse(acc.arguments || '{}');
    } catch {
      args = { _raw: acc.arguments };
    }
    yield { toolCall: { id: acc.id, name: acc.name, arguments: args } };
  }

  if (sawToolCall || toolAcc.size > 0) {
    stopReason = mapFinishReason(stopReason === 'stop' ? 'tool_calls' : stopReason, true);
  }

  yield { stopReason, usage };
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
      reasoning?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ApiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function buildRequestBody(model: string, req: ChatModelRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: req.messages.map(toApiMessage),
    stream,
  };
  if (!req.textCompletion && req.tools.length > 0) {
    body.tools = req.tools.map(toApiTool);
  }
  return body;
}

async function postJson(
  fetchImpl: typeof fetch,
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = `${baseUrl}/chat/completions`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM HTTP ${res.status}: ${errText.slice(0, 500)}`);
  }
  return res.json();
}

async function* iterateSseDataLines(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  const chunks: AsyncIterable<Uint8Array> =
    typeof (body as ReadableStream<Uint8Array>).getReader === 'function'
      ? readableToAsyncIterable(body as ReadableStream<Uint8Array>)
      : (body as AsyncIterable<Uint8Array>);

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trimStart();
      if (payload) yield payload;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const raw of buffer.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trimStart();
      if (payload) yield payload;
    }
  }
}

async function* readableToAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
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
  const thinking = msg?.reasoning_content?.trim() || msg?.reasoning?.trim() || undefined;
  const toolCalls = (msg?.tool_calls ?? [])
    .map((tc): ToolCall | undefined => {
      const toolName = tc.function?.name;
      if (!toolName) return undefined;
      let args: unknown = {};
      const raw = tc.function?.arguments ?? '{}';
      try {
        args = JSON.parse(raw);
      } catch {
        args = { _raw: raw };
      }
      return { id: tc.id, name: toolName, arguments: args };
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
