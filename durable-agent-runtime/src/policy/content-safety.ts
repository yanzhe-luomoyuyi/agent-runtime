/**
 * Content safety provider — pluggable pre-model / post-model guardrails.
 *
 * Three checkpoints, each swappable independently so you can mix providers
 * (e.g. Azure Content Safety for text moderation + Llama Guard for jailbreak):
 *
 *   pre-model:   checkContent(prompt)  — harmful content in the user's input
 *                checkJailbreak(prompt) — prompt injection / DAN-style attacks
 *   post-model:  checkOutput(response) — harmful / ungrounded model output
 *
 * The default `NoOpContentSafety` passes everything (safe by default).
 * Swap in a real provider by implementing the interface — the `PolicyEnforcer`
 * delegates to it, and the runtime funnel records `PolicyDenied` events on
 * violations, so every blocked call is observable and auditable.
 */

// ── Result types ─────────────────────────────────────────────────────────

export interface ContentCheckResult {
  /** false = this content was flagged as unsafe and should be blocked. */
  safe: boolean;
  /** The category of violation (e.g. "hate", "sexual", "violence"). */
  category?: string;
  /** Severity 0–7 (Azure scale) or provider-specific. */
  severity?: number;
  /** Human-readable explanation. */
  reason?: string;
}

export interface JailbreakResult {
  /** false = jailbreak / prompt injection detected. */
  safe: boolean;
  /** What kind of attack was detected. */
  attackType?: string;
  reason?: string;
}

export interface OutputCheckResult {
  /** false = model output is unsafe / ungrounded / malformed. */
  safe: boolean;
  category?: string;
  reason?: string;
}

// ── Provider interface ───────────────────────────────────────────────────

export interface ContentSafetyProvider {
  /** Check user/agent input for harmful content before it reaches the model. */
  checkContent(text: string): Promise<ContentCheckResult>;

  /** Check for prompt injection / jailbreak attempts. */
  checkJailbreak(text: string): Promise<JailbreakResult>;

  /**
   * Check the model's response before it is returned to the agent/workflow.
   * `context` is optional grounding text (e.g. the retrieved documents the
   * answer should be based on) for groundedness checks.
   */
  checkOutput(text: string, context?: string): Promise<OutputCheckResult>;
}

// ── Built-in implementations ─────────────────────────────────────────────

const SAFE_CONTENT: ContentCheckResult = { safe: true };
const SAFE_JAILBREAK: JailbreakResult = { safe: true };
const SAFE_OUTPUT: OutputCheckResult = { safe: true };

/**
 * No-op provider — every check passes. This is the default so existing
 * workflows and tests are unaffected until you explicitly swap in a real
 * safety provider.
 */
export class NoOpContentSafety implements ContentSafetyProvider {
  async checkContent(_text: string): Promise<ContentCheckResult> {
    return SAFE_CONTENT;
  }
  async checkJailbreak(_text: string): Promise<JailbreakResult> {
    return SAFE_JAILBREAK;
  }
  async checkOutput(_text: string, _context?: string): Promise<OutputCheckResult> {
    return SAFE_OUTPUT;
  }
}

/**
 * Demo / test helper: a static safety provider that blocks text matching
 * given patterns. Useful for deterministic eval — you can assert that a
 * specific dangerous prompt is correctly caught without calling a real API.
 */
export class PatternContentSafety implements ContentSafetyProvider {
  constructor(
    private readonly blockedPatterns: RegExp[] = [],
    private readonly jailbreakPatterns: RegExp[] = [],
  ) {}

  async checkContent(text: string): Promise<ContentCheckResult> {
    for (const p of this.blockedPatterns) {
      if (p.test(text)) {
        return { safe: false, category: 'blocked_pattern', reason: `Matched pattern: ${p.source}` };
      }
    }
    return SAFE_CONTENT;
  }

  async checkJailbreak(text: string): Promise<JailbreakResult> {
    for (const p of this.jailbreakPatterns) {
      if (p.test(text)) {
        return {
          safe: false,
          attackType: 'prompt_injection',
          reason: `Matched jailbreak pattern: ${p.source}`,
        };
      }
    }
    return SAFE_JAILBREAK;
  }

  async checkOutput(text: string, _context?: string): Promise<OutputCheckResult> {
    for (const p of this.blockedPatterns) {
      if (p.test(text)) {
        return { safe: false, category: 'blocked_pattern', reason: `Matched pattern: ${p.source}` };
      }
    }
    return SAFE_OUTPUT;
  }
}
