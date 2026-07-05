/**
 * Declarative policy layer — a reusable guardrail that sits on the runtime's
 * single tool/model funnel (see Runtime.makeContext -> callTool / callModel).
 *
 * Policy is DATA, not code: a `Policy` object (sourced from agent.config.json by
 * the CLI) declares which tools an agent may call, a cumulative model-cost
 * ceiling, and the PII patterns to redact from anything sent to the model.
 * Because enforcement lives on the funnel — not inside any individual tool or
 * server — the same policy composes over any workflow and any tool, local or
 * MCP-backed.
 *
 * Contrast with hardcoding guardrails inside one server (e.g. a checkpoint
 * server): that couples policy to a single integration and can't be reused.
 * Here the policy is a standalone, declarative, composable middleware.
 */

export type PolicyViolationCode = 'tool_not_allowed' | 'budget_exceeded';

/** Raised when a call is refused by the policy. Carries a machine-readable code. */
export class PolicyViolationError extends Error {
  constructor(
    readonly code: PolicyViolationCode,
    readonly scope: 'tool' | 'model',
    readonly target: string,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyViolationError';
  }
}

/** A named PII pattern. The enforcer always applies it globally (adds the `g` flag). */
export interface RedactionRule {
  name: string;
  pattern: RegExp;
}

export interface Policy {
  /** Tool allow-list. `undefined` means "no restriction" (every tool allowed). */
  allowedTools?: string[];
  /** Cumulative model-cost ceiling in USD. `undefined` means unbounded. */
  maxCostUsd?: number;
  /** PII patterns masked before a prompt leaves the runtime. */
  redactions?: RedactionRule[];
}

/**
 * Built-in PII rules, addressable by name so a JSON config can enable them
 * (regexes aren't JSON-serializable). Deliberately conservative — these are demo
 * heuristics, not a compliance-grade PII detector.
 */
export const BUILTIN_REDACTIONS: Record<string, RedactionRule> = {
  email: { name: 'email', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  phone: { name: 'phone', pattern: /\+?\d[\d ()-]{7,}\d/g },
  ssn: { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  secret: { name: 'secret', pattern: /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{8,})/g },
  'credit-card': { name: 'credit-card', pattern: /\b(?:\d[ -]?){13,16}\b/g },
};

/** Resolve a list of built-in rule names (from config) into `RedactionRule`s. */
export function resolveRedactions(names: string[]): RedactionRule[] {
  return names
    .map((name) => BUILTIN_REDACTIONS[name])
    .filter((rule): rule is RedactionRule => rule !== undefined);
}

export class PolicyEnforcer {
  constructor(private readonly policy: Policy) {}

  /** The declared policy (read-only view for inspection/observability). */
  get declared(): Policy {
    return this.policy;
  }

  /** Throw if `tool` is not on the allow-list. No allow-list => allow everything. */
  checkTool(tool: string): void {
    const allow = this.policy.allowedTools;
    if (allow && !allow.includes(tool)) {
      throw new PolicyViolationError('tool_not_allowed', 'tool', tool, `Tool "${tool}" is not on the allow-list`);
    }
  }

  /**
   * Throw if cumulative spend has already reached the budget ceiling. Gating on
   * "already exceeded" (rather than predicting the next call's cost) keeps the
   * check cheap and deterministic; the trade-off is that the call that crosses
   * the line is the first one refused, not truncated mid-flight.
   */
  checkBudget(spentUsd: number, target: string): void {
    const max = this.policy.maxCostUsd;
    if (max !== undefined && spentUsd >= max) {
      throw new PolicyViolationError(
        'budget_exceeded',
        'model',
        target,
        `Cost budget $${max} exhausted (already spent $${spentUsd.toFixed(6)})`,
      );
    }
  }

  /**
   * Mask every configured PII pattern. Returns the redacted text plus the names
   * of the rules that actually fired (for observability). A fresh regex is built
   * per rule so global-match state never leaks between calls.
   */
  redact(text: string): { text: string; applied: string[] } {
    const applied: string[] = [];
    let out = text;
    for (const rule of this.policy.redactions ?? []) {
      const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
      const re = new RegExp(rule.pattern.source, flags);
      let fired = false;
      out = out.replace(re, () => {
        fired = true;
        return `[REDACTED:${rule.name}]`;
      });
      if (fired) applied.push(rule.name);
    }
    return { text: out, applied };
  }
}
