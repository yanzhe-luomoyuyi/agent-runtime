/**
 * C: scratchpad — filesystem-as-context memory (opt-in).
 *
 * The naive fix for an oversized tool result is `truncateObservation`, which
 * throws the tail away forever. That is lossy: the agent can never get the
 * dropped content back. The scratchpad follows the Manus / Claude Code pattern
 * instead — "filesystem as context": large content is OFFLOADED to an external
 * store, and only a short pointer + preview stays in the window. The model can
 * pull the full content back on demand with a `scratchpad_read` tool.
 *
 * This is a `ToolInvoker` DECORATOR, mirroring `CompensatingToolInvoker`: the
 * core loop never changes. Wrap your tools with it and (a) oversized results are
 * auto-offloaded, (b) two extra tools (`scratchpad_read`, `scratchpad_list`) are
 * advertised so the model can retrieve them.
 *
 * ## Determinism / durable replay
 *
 * Offload ids are derived from the call's deterministic durable `key` when
 * present (else a monotonic counter). Since tool calls replay in the same order
 * with the same keys, the scratchpad rebuilds identically on resume — no special
 * persistence needed for correctness (though a real host may back the store with
 * disk for cross-process reads).
 */

import type { CallOptions, ChatModel, ToolInvoker, ToolSpec } from '@agent/contracts';

/** One stored entry. */
export interface ScratchpadEntry {
  id: string;
  content: string;
  /** Where it came from — the tool whose output was offloaded, if any. */
  source?: string;
  /** Character length of the stored content. */
  length: number;
  /** Optional LLM-generated summary, produced at offload time. */
  summary?: string;
}

/**
 * Async content summarizer for write-time compaction. Given raw text content
 * and context (durable key + tool name), produce a concise summary.
 *
 * The summary is stored alongside the full content and used as the preview
 * in the offload pointer — far more useful to the model than raw truncation.
 *
 * Create one from a `ChatModel` with {@link createScratchpadSummarizer}.
 */
export type ContentSummarizer = (
  content: string,
  ctx: { key: string; toolName: string },
) => Promise<string>;

/**
 * A simple keyed content store. In-memory by default; swap the backing map for
 * a disk/KV implementation by subclassing or wrapping. Deterministic.
 */
export class Scratchpad {
  private readonly store = new Map<string, ScratchpadEntry>();

  write(id: string, content: string, source?: string, summary?: string): ScratchpadEntry {
    const entry: ScratchpadEntry = { id, content, length: content.length };
    if (source !== undefined) entry.source = source;
    if (summary !== undefined) entry.summary = summary;
    this.store.set(id, entry);
    return entry;
  }

  read(id: string): ScratchpadEntry | undefined {
    return this.store.get(id);
  }

  has(id: string): boolean {
    return this.store.has(id);
  }

  /** Metadata for every stored entry (includes summary if present, but not full content). */
  list(): Array<Omit<ScratchpadEntry, 'content'>> {
    return [...this.store.values()].map(({ content: _c, ...meta }) => meta);
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

export interface ScratchpadToolInvokerOptions {
  /** The store to offload into. Defaults to a fresh in-memory `Scratchpad`. */
  store?: Scratchpad;
  /**
   * Results whose string length exceeds this are offloaded and replaced by a
   * pointer. Default 4000 characters.
   */
  offloadThreshold?: number;
  /**
   * How many leading characters of an offloaded result to keep as a preview.
   * Default 300. Ignored when `summarize` is provided — the LLM summary
   * replaces the raw preview.
   */
  previewChars?: number;
  /**
   * Tool names to EXCLUDE from auto-offload (e.g. tools whose result the model
   * must always see in full). The scratchpad read/list tools are always excluded.
   */
  neverOffload?: string[];
  /**
   * Optional async summarizer. When set, oversized results are summarised at
   * offload time via an LLM call, and the summary is used as the preview in
   * the offload pointer. The full content is still stored and retrievable
   * via `scratchpad_read`.
   *
   * The summarizer receives `(content, { key, toolName })`. The `key` is the
   * durable idempotency key so a durable host can replay the cached summary.
   */
  summarize?: ContentSummarizer;
  /**
   * Custom system instructions for the summarizer LLM call. Only used when
   * `summarize` is created via {@link createScratchpadSummarizer}.
   */
  summarizeInstructions?: string;
}

const READ_TOOL = 'scratchpad_read';
const LIST_TOOL = 'scratchpad_list';

const SCRATCHPAD_SPECS: ToolSpec[] = [
  {
    name: READ_TOOL,
    description:
      'Retrieve content from a previously offloaded result by its scratchpad id ' +
      '(ids look like "sp-<n>" and appear in offload pointers). ' +
      'For large results, use optional `offset` (0-based char index) and `limit` (max chars) ' +
      'to read a specific chunk instead of pulling the entire content into context.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The scratchpad id to read.' },
        offset: {
          type: 'integer',
          description: '0-based character offset to start reading from. Default 0.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum characters to return. Omit to return all remaining content.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: LIST_TOOL,
    description:
      'List the ids, sizes, sources, and summaries (if any) of all offloaded results in the scratchpad.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** Return type for chunked scratchpad reads. */
interface ChunkResult {
  content: string;
  offset: number;
  length: number;
  totalLength: number;
  hasMore: boolean;
  id: string;
}

/**
 * Wraps a `ToolInvoker`, auto-offloading oversized results to a `Scratchpad` and
 * exposing `scratchpad_read` / `scratchpad_list` so the model can retrieve them.
 *
 * Supports chunked reading (offset/limit) and optional write-time LLM summarization.
 */
export class ScratchpadToolInvoker implements ToolInvoker {
  readonly store: Scratchpad;
  private readonly offloadThreshold: number;
  private readonly previewChars: number;
  private readonly neverOffload: Set<string>;
  private readonly summarize?: ContentSummarizer;
  private counter = 0;

  constructor(
    private readonly inner: ToolInvoker,
    opts: ScratchpadToolInvokerOptions = {},
  ) {
    this.store = opts.store ?? new Scratchpad();
    this.offloadThreshold = opts.offloadThreshold ?? 4000;
    this.previewChars = opts.previewChars ?? 300;
    this.neverOffload = new Set([READ_TOOL, LIST_TOOL, ...(opts.neverOffload ?? [])]);
    this.summarize = opts.summarize;
  }

  list(): ToolSpec[] {
    return [...this.inner.list(), ...SCRATCHPAD_SPECS];
  }

  async call(name: string, args: unknown, opts?: CallOptions): Promise<unknown> {
    // Handle the scratchpad's own tools without touching the inner invoker.
    if (name === READ_TOOL) {
      return this._handleRead(args);
    }
    if (name === LIST_TOOL) {
      return this.store.list();
    }

    const result = await this.inner.call(name, args, opts);

    // Only string results are candidates for offload; structured results pass through.
    if (typeof result !== 'string' || this.neverOffload.has(name) || result.length <= this.offloadThreshold) {
      return result;
    }

    const id = this.nextId(opts?.key);

    // ── Write-time summarisation ──
    let summary: string | undefined;
    if (this.summarize) {
      try {
        summary = await this.summarize(result, {
          key: opts?.key ?? `sp-${this.counter}`,
          toolName: name,
        });
      } catch {
        // Summarisation is best-effort — fall through to raw preview on failure.
      }
    }

    this.store.write(id, result, name, summary);

    // Build the offload pointer.
    const previewText = summary
      ? `Summary: ${summary}`
      : `Preview: ${JSON.stringify(result.slice(0, this.previewChars))}${result.length > this.previewChars ? '…' : ''}`;

    const chunkHint =
      result.length > 8000
        ? ` Hint: use offset/limit with ${READ_TOOL} to read in chunks (e.g. {"id":"${id}","offset":0,"limit":4000}).`
        : '';

    return (
      `[Offloaded ${result.length} chars from "${name}" to scratchpad id="${id}". ` +
      `${previewText} ` +
      `Call ${READ_TOOL}({"id":"${id}"}) to read the full content.${chunkHint}]`
    );
  }

  // ── scratchpad_read handler with chunked reading ──

  private _handleRead(args: unknown): ChunkResult | string {
    const a = args as { id?: unknown; offset?: unknown; limit?: unknown };
    const id = a.id;
    if (typeof id !== 'string') return `ERROR: scratchpad_read requires a string "id".`;

    const entry = this.store.read(id);
    if (!entry) return `ERROR: no scratchpad entry with id "${id}".`;

    const offset = typeof a.offset === 'number' && Number.isFinite(a.offset) ? Math.max(0, Math.floor(a.offset)) : 0;
    const limit =
      typeof a.limit === 'number' && Number.isFinite(a.limit) ? Math.max(1, Math.floor(a.limit)) : undefined;

    // No chunking requested — return full content (backward compatible).
    if (offset === 0 && limit === undefined) {
      return entry.content;
    }

    // Chunked read.
    const totalLength = entry.content.length;
    const clampedOffset = Math.min(offset, totalLength);
    const end = limit !== undefined ? Math.min(clampedOffset + limit, totalLength) : totalLength;
    const chunk = entry.content.slice(clampedOffset, end);

    return {
      content: chunk,
      offset: clampedOffset,
      length: chunk.length,
      totalLength,
      hasMore: end < totalLength,
      id,
    };
  }

  /** Deterministic id: derived from the durable key when present, else a counter. */
  private nextId(key?: string): string {
    if (key) return `sp-${key.replace(/[^A-Za-z0-9_:-]/g, '_')}`;
    return `sp-${this.counter++}`;
  }
}

// ── Factory: create a ContentSummarizer from a ChatModel ──

const DEFAULT_SCRATCHPAD_SUMMARIZE_INSTRUCTIONS =
  'You are a precise summarizer for tool outputs. Produce a concise, factual summary ' +
  'that preserves key data, structure, counts, errors, file paths, and any actionable ' +
  'information. Be specific — include numbers, names, and identifiers when present. ' +
  'Do not invent details. The summary will be shown to an agent deciding whether to ' +
  'retrieve the full content.';

/**
 * Create a `ContentSummarizer` backed by a `ChatModel`.
 *
 * Follows the same pattern as `createModelSummarizer` in `manager.ts`: uses
 * `textCompletion: true` so the call is treated as plain text, not an agentic turn.
 *
 * @param model  The ChatModel to use for summarization.
 * @param opts   Optional custom instructions (defaults to tool-output-oriented prompt).
 */
export function createScratchpadSummarizer(
  model: ChatModel,
  opts: { instructions?: string } = {},
): ContentSummarizer {
  const instructions = opts.instructions ?? DEFAULT_SCRATCHPAD_SUMMARIZE_INSTRUCTIONS;
  return async (content, ctx) => {
    // Truncate very long content before sending to the summarizer LLM
    // to avoid burning tokens on summarisation itself.
    const MAX_SUMMARIZE_INPUT = 24_000;
    const truncated =
      content.length > MAX_SUMMARIZE_INPUT
        ? content.slice(0, MAX_SUMMARIZE_INPUT) +
          `\n\n[... ${content.length - MAX_SUMMARIZE_INPUT} more chars truncated for summarisation]`
        : content;

    const resp = await model.chat({
      messages: [
        { role: 'system', content: instructions },
        {
          role: 'user',
          content:
            `Summarize this tool output from "${ctx.toolName}". Be concise but preserve ` +
            `specifics (numbers, identifiers, errors, file paths, structure):\n\n${truncated}`,
        },
      ],
      tools: [],
      key: ctx.key,
      textCompletion: true,
    });
    return (resp.message.content ?? '').trim();
  };
}
