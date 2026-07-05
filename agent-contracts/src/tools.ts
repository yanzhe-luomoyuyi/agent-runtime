/**
 * Tools — the specification a model needs to call a tool, and the abstract seam
 * through which the harness actually invokes one.
 *
 * `ToolInvoker` is deliberately tiny and host-agnostic: the harness depends only
 * on `list()` + `call()`. A plain in-memory host implements it directly; the
 * durable-agent-runtime implements it by delegating to its idempotent
 * `ctx.callTool`, passing the harness-supplied `key` so a replayed run reuses the
 * recorded result instead of re-running the side effect. That single `key` is
 * the whole durability contract between the two projects.
 */

/**
 * A minimal JSON Schema subset — enough to describe tool inputs and to validate
 * model-supplied arguments. Intentionally not a full JSON Schema implementation.
 */
export interface JSONSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  description?: string;
  additionalProperties?: boolean | JSONSchema;
}

/** What the model is told about a callable tool. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JSONSchema;
}

/** Per-call options. `key` is the deterministic idempotency handle (see file header). */
export interface CallOptions {
  key?: string;
}

/** The abstract tool-execution seam the harness calls into. */
export interface ToolInvoker {
  /** Advertise the callable tools (name/description/inputSchema). */
  list(): ToolSpec[];
  /** Execute a tool by name. May throw — the harness turns throws into observations. */
  call(name: string, args: unknown, opts?: CallOptions): Promise<unknown>;
}
