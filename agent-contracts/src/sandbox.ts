/**
 * Execution boundary for tool invocations.
 *
 * Hosts can enforce path-based or policy-based constraints before a tool
 * runs, while the runtime remains responsible for the durable call funnel.
 */
export interface ExecutionSandbox {
  readonly kind?: string;
  /** Resolve a user-supplied path against the sandbox root. */
  resolvePath(path: string): string;
  /** Enforce sandbox rules for a tool call before it executes. */
  guardToolInvocation(toolName: string, args: unknown): Promise<void>;
}
