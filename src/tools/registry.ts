/**
 * Tool registry.
 *
 * A `ToolDef` mirrors the shape of an MCP tool (name, description, JSON input
 * schema, handler). In D1 the handlers are local and deterministic; later a
 * single adapter can expose real MCP servers through this same interface, so
 * the runtime never needs to know whether a tool is local or remote.
 */

export interface ToolDef<Args = unknown, Result = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Args) => Promise<Result> | Result;
}

// Tools are stored heterogeneously (each has its own Args/Result types), so the
// registry works with the permissive `ToolDef<any, any>`. Call sites keep their
// own precise types via the generic on `callTool<R>()`.
type AnyToolDef = ToolDef<any, any>;

export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDef>();

  register(tool: AnyToolDef): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AnyToolDef {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool;
  }

  list(): AnyToolDef[] {
    return [...this.tools.values()];
  }
}
