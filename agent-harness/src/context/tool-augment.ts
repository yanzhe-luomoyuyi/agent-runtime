/**
 * C: tool augmentation — add extra tools to any `ToolInvoker` without touching
 * the core loop.
 *
 * `AugmentedToolInvoker` is the shared plumbing behind the memory and retrieval
 * features: it wraps an inner invoker and advertises a set of extra
 * `ManagedToolDef`s, dispatching those to their handlers and delegating
 * everything else. It mirrors the decorator style of `ScratchpadToolInvoker` /
 * `CompensatingToolInvoker`.
 *
 * ## Determinism / durable replay
 *
 * This decorator handles the extra tools LOCALLY (it does not route them through
 * the host's durable seam). That is fine for:
 *   - plain, non-durable hosts (there is no replay), and
 *   - tools whose result is a pure function of the transcript.
 *
 * For tools that read MUTABLE cross-session state (e.g. a shared memory store),
 * a durable host must instead register the equivalent tools in its own registry,
 * so each call goes through `ctx.callTool` and is recorded in the event log —
 * otherwise a replay could observe a store that has since changed.
 */

import type { CallOptions, JSONSchema, ToolInvoker, ToolSpec } from '@agent/contracts';

/** A self-contained tool: its advertised spec plus the handler that runs it. */
export interface ManagedToolDef {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  handler: (args: unknown, opts?: CallOptions) => unknown | Promise<unknown>;
}

/** Project a `ManagedToolDef` down to the spec the model is shown. */
export function toToolSpec(def: ManagedToolDef): ToolSpec {
  return { name: def.name, description: def.description, inputSchema: def.inputSchema };
}

/**
 * Wrap a `ToolInvoker`, advertising and dispatching a set of extra tools.
 * Unknown tool names delegate to the inner invoker unchanged.
 */
export class AugmentedToolInvoker implements ToolInvoker {
  private readonly extra = new Map<string, ManagedToolDef>();

  constructor(
    private readonly inner: ToolInvoker,
    defs: ManagedToolDef[],
  ) {
    for (const d of defs) this.extra.set(d.name, d);
  }

  list(): ToolSpec[] {
    return [...this.inner.list(), ...[...this.extra.values()].map(toToolSpec)];
  }

  async call(name: string, args: unknown, opts?: CallOptions): Promise<unknown> {
    const def = this.extra.get(name);
    if (def) return def.handler(args, opts);
    return this.inner.call(name, args, opts);
  }
}
