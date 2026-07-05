/**
 * Deterministic mock "agent brain" — plays the role a real tool-calling LLM would
 * in the agentic loop (../agent-loop.ts). It reads the prompt the harness builds
 * (goal + tools + transcript) and returns the next decision as JSON, so runs are
 * offline, reproducible, and give stable tests. A real deployment swaps this for a
 * live LLM implementing the same `ModelProvider.complete()` contract — the harness
 * and runtime are unchanged.
 *
 * Part of the demo *workload*, not the runtime. Its policy for the issue-fix demo:
 *   getIssue  ->  searchCode  ->  finish
 * decided purely from which tools already appear in the transcript, so it is
 * independent of the turn budget and robust across resume.
 */

import { estimateTokens, type ModelProvider, type ModelResult } from '../model/provider.js';

export class MockAgentModel implements ModelProvider {
  readonly name = 'mock-agent';

  async complete(prompt: string): Promise<ModelResult> {
    const decision = this.decide(prompt);
    const text = JSON.stringify(decision);
    return { text, promptTokens: estimateTokens(prompt), completionTokens: estimateTokens(text) };
  }

  private decide(prompt: string): unknown {
    const goal = /Goal:\s*(.+)/.exec(prompt)?.[1]?.trim() ?? '';
    const called = new Set<string>();
    for (const m of prompt.matchAll(/called (\w+)\(/g)) {
      if (m[1]) called.add(m[1]);
    }

    if (!called.has('getIssue')) {
      return { action: 'call_tool', tool: 'getIssue', args: { issue: goal } };
    }
    if (!called.has('searchCode')) {
      return { action: 'call_tool', tool: 'searchCode', args: { query: goal } };
    }
    return { action: 'finish', answer: finalAnswer(goal) };
  }
}

function finalAnswer(goal: string): string {
  if (/null|session|login|auth/i.test(goal)) {
    return 'Guard against a null session in src/auth/login.ts before reading user.token.';
  }
  if (/render|button|ui|component/i.test(goal)) {
    return 'Fix the conditional render in src/ui/Button.tsx so the component mounts.';
  }
  return `Investigated and addressed: ${goal}`;
}
