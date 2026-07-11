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

import type { CallOptions, ToolInvoker, ToolSpec } from '@agent/contracts';

/** One stored entry. */
export interface ScratchpadEntry {
  id: string;
  content: string;
  /** Where it came from — the tool whose output was offloaded, if any. */
  source?: string;
  /** Character length of the stored content. */
  length: number;
}

/**
 * A simple keyed content store. In-memory by default; swap the backing map for
 * a disk/KV implementation by subclassing or wrapping. Deterministic.
 */
export class Scratchpad {
  private readonly store = new Map<string, ScratchpadEntry>();

  write(id: string, content: string, source?: string): ScratchpadEntry {
    const entry: ScratchpadEntry = { id, content, length: content.length };
    if (source !== undefined) entry.source = source;
    this.store.set(id, entry);
    return entry;
  }

  read(id: string): ScratchpadEntry | undefined {
    return this.store.get(id);
  }

  has(id: string): boolean {
    return this.store.has(id);
  }

  /** Metadata for every stored entry (without the full content). */
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
  /** How many leading characters of an offloaded result to keep as a preview. Default 300. */
  previewChars?: number;
  /**
   * Tool names to EXCLUDE from auto-offload (e.g. tools whose result the model
   * must always see in full). The scratchpad read/list tools are always excluded.
   */
  neverOffload?: string[];
}

const READ_TOOL = 'scratchpad_read';
const LIST_TOOL = 'scratchpad_list';

const SCRATCHPAD_SPECS: ToolSpec[] = [
  {
    name: READ_TOOL,
    description:
      'Retrieve the full content of a previously offloaded result by its scratchpad id ' +
      '(ids look like "sp-<n>" and appear in offload pointers).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: LIST_TOOL,
    description: 'List the ids and sizes of all offloaded results currently in the scratchpad.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/**
 * Wraps a `ToolInvoker`, auto-offloading oversized results to a `Scratchpad` and
 * exposing `scratchpad_read` / `scratchpad_list` so the model can retrieve them.
 */
export class ScratchpadToolInvoker implements ToolInvoker {
  readonly store: Scratchpad;
  private readonly offloadThreshold: number;
  private readonly previewChars: number;
  private readonly neverOffload: Set<string>;
  private counter = 0;

  constructor(
    private readonly inner: ToolInvoker,
    opts: ScratchpadToolInvokerOptions = {},
  ) {
    this.store = opts.store ?? new Scratchpad();
    this.offloadThreshold = opts.offloadThreshold ?? 4000;
    this.previewChars = opts.previewChars ?? 300;
    this.neverOffload = new Set([READ_TOOL, LIST_TOOL, ...(opts.neverOffload ?? [])]);
  }

  list(): ToolSpec[] {
    return [...this.inner.list(), ...SCRATCHPAD_SPECS];
  }

  async call(name: string, args: unknown, opts?: CallOptions): Promise<unknown> {
    // Handle the scratchpad's own tools without touching the inner invoker.
    if (name === READ_TOOL) {
      const id = (args as { id?: unknown })?.id;
      if (typeof id !== 'string') return `ERROR: scratchpad_read requires a string "id".`;
      const entry = this.store.read(id);
      return entry ? entry.content : `ERROR: no scratchpad entry with id "${id}".`;
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
    this.store.write(id, result, name);
    const preview = result.slice(0, this.previewChars);
    return (
      `[Offloaded ${result.length} chars from "${name}" to scratchpad id="${id}". ` +
      `Preview: ${JSON.stringify(preview)}${result.length > this.previewChars ? '…' : ''} ` +
      `Call ${READ_TOOL}({"id":"${id}"}) to read the full content.]`
    );
  }

  /** Deterministic id: derived from the durable key when present, else a counter. */
  private nextId(key?: string): string {
    if (key) return `sp-${key.replace(/[^A-Za-z0-9_:-]/g, '_')}`;
    return `sp-${this.counter++}`;
  }
}
