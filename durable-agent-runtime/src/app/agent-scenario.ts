/**
 * Deterministic mock "agent brain" for the harness loop. Reads the harness
 * prompt (goal + tools + transcript) and returns JSON tool/finish decisions so
 * runs stay offline and reproducible. Final answers come from shared fixtures.
 */

import { estimateTokens, type ModelProvider, type ModelResult } from '../model/provider.js';

import { proposeForGoal } from './demo-fixtures.js';

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
    return { action: 'finish', answer: proposeForGoal(goal) };
  }
}
