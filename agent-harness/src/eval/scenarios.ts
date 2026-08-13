/**
 * Built-in L2 harness eval scenarios: loop trajectory, assemble/compact
 * ablation, retrieval gate, scratchpad offload, loop profiles, and HITL
 * approver. All use testkit doubles — CI-safe, no network.
 */

import { ContextManager } from '../context/manager.js';
import { ScratchpadToolInvoker } from '../context/scratchpad.js';
import { autoApprove, countingApprover, requireApprovalFor } from '../control/human.js';
import {
  MockToolInvoker,
  RuleChatModel,
  ScriptedChatModel,
  finalResponse,
  toolCall,
  toolCallResponse,
} from '../testkit/index.js';
import {
  assembleAblationMessages,
  charTokenizer,
  compactProtectMessages,
  demoBigRead,
  demoDeploy,
  demoGetIssue,
  demoReadFile,
  demoSearchCode,
  makeAssembleContext,
  makeCompactContext,
} from './fixtures.js';
import {
  afterAssembleDropsToolCallId,
  afterAssembleKeepsToolCallId,
  afterCompactDropsToolCallId,
  afterCompactKeepsToolCallId,
  answerContains,
  assembleRespectsBudgetGate,
  assembleTriggered,
  compactOutcomeIs,
  compactProtectedUnitsAtLeast,
  compactReasonIs,
  compactRemovedToolResultsAtLeast,
  humanInterventionRequested,
  humanInterventionsUnder,
  importanceScoringIs,
  messageContentIncludes,
  noMessageContentIncludes,
  noToolFailures,
  pinnedRecentSurvives,
  recalledAfterEviction,
  retrievalMessageCountIs,
  retrievalStaysUntrusted,
  runFinished,
  scratchpadNotOffloaded,
  scratchpadOffloaded,
  stopReasonIs,
  toolResultsUntrusted,
  toolsUsedEquals,
  toolsUsedIncludes,
  turnsUnder,
} from './scorers.js';
import type { Scenario } from './types.js';

function approverCountsSensitiveToolsScenario(): Scenario {
  const { approver, stats } = countingApprover(autoApprove);
  const gated = requireApprovalFor(['deploy'], approver);
  return {
    name: 'approver-counts-sensitive-tools',
    label: 'hitl',
    setup: () => {
      const tools = new MockToolInvoker([demoGetIssue, demoDeploy]);
      const model = new ScriptedChatModel([
        toolCallResponse([toolCall('c1', 'getIssue', { issue: 'x' })]),
        toolCallResponse([toolCall('c2', 'deploy', { target: 'prod' })]),
        finalResponse('deployed'),
      ]);
      return { goal: 'x', model, tools, approver: gated };
    },
    checks: [
      runFinished(),
      toolsUsedIncludes('getIssue', 'deploy'),
      humanInterventionRequested(stats, 1),
      humanInterventionsUnder(stats, 1),
    ],
  };
}

/** Default suite for `npm test` / interview demos. */
export function defaultHarnessScenarios(): Scenario[] {
  return [
    {
      name: 'happy-path-trajectory',
      label: 'loop',
      setup: () => {
        const tools = new MockToolInvoker([demoGetIssue, demoSearchCode]);
        const model = new RuleChatModel((req) => {
          const called = new Set(req.messages.filter((m) => m.role === 'tool').map((m) => m.name));
          if (!called.has('getIssue')) return toolCallResponse([toolCall('c1', 'getIssue', { issue: 'x' })]);
          if (!called.has('searchCode')) return toolCallResponse([toolCall('c2', 'searchCode', { query: 'x' })]);
          return finalResponse('fix src/auth/login.ts');
        });
        return { goal: 'x', model, tools };
      },
      checks: [
        runFinished(),
        toolsUsedEquals(['getIssue', 'searchCode']),
        answerContains('login.ts'),
        turnsUnder(4),
        noToolFailures(),
        toolResultsUntrusted(),
      ],
    },

    {
      name: 'loop-detector-trips',
      label: 'loop',
      setup: () => {
        const tools = new MockToolInvoker([demoGetIssue]);
        const model = new RuleChatModel(() =>
          toolCallResponse([toolCall('c', 'getIssue', { issue: 'same' })]),
        );
        return { goal: 'x', model, tools, loopLimit: 3, maxTurns: 20 };
      },
      checks: [stopReasonIs('loop_detected')],
    },

    {
      name: 'assemble-respects-budget-gate',
      label: 'loop',
      setup: () => {
        const tools = new MockToolInvoker([demoGetIssue]);
        const model = new ScriptedChatModel([finalResponse('done')]);
        return {
          goal: 'x',
          model,
          tools,
          systemPrompt: 'S',
          conversationHistory: assembleAblationMessages(),
          context: new ContextManager({
            maxPromptTokens: 100,
            outputReserveTokens: 0,
            keepRecentMessages: 1,
            goalProtected: true,
            importanceScoring: true,
            tokenizer: charTokenizer,
          }),
        };
      },
      checks: [runFinished(), assembleTriggered(), assembleRespectsBudgetGate()],
    },

    {
      name: 'recall-after-eviction',
      label: 'loop',
      setup: () => {
        const tools = new MockToolInvoker([demoReadFile]);
        const model = new ScriptedChatModel([
          toolCallResponse([toolCall('c1', 'read_file', { path: 'a.ts' })]),
          toolCallResponse([toolCall('c2', 'read_file', { path: 'b.ts' })]),
          toolCallResponse([toolCall('c3', 'read_file', { path: 'c.ts' })]),
          toolCallResponse([toolCall('c4', 'read_file', { path: 'a.ts' })]),
          finalResponse('done'),
        ]);
        return {
          goal: 'x',
          model,
          tools,
          systemPrompt: 'S',
          maxTurns: 10,
          loopLimit: 99,
          context: new ContextManager({
            maxPromptTokens: 160,
            outputReserveTokens: 0,
            keepRecentMessages: 2,
            goalProtected: true,
            importanceScoring: true,
            tokenizer: charTokenizer,
          }),
        };
      },
      checks: [runFinished(), recalledAfterEviction(1), assembleRespectsBudgetGate()],
    },

    {
      name: 'ablation-importance-keeps-error',
      kind: 'assemble',
      label: 'importance+pin',
      setup: () => ({
        messages: assembleAblationMessages(),
        context: makeAssembleContext(true),
      }),
      checks: [
        assembleTriggered(),
        pinnedRecentSurvives(),
        importanceScoringIs(true),
        afterAssembleKeepsToolCallId('e'),
        assembleRespectsBudgetGate(),
      ],
    },

    {
      name: 'ablation-recency-drops-error',
      kind: 'assemble',
      label: 'pure-recency',
      setup: () => ({
        messages: assembleAblationMessages(),
        context: makeAssembleContext(false),
      }),
      checks: [
        assembleTriggered(),
        pinnedRecentSurvives(),
        importanceScoringIs(false),
        afterAssembleDropsToolCallId('e'),
        assembleRespectsBudgetGate(),
      ],
    },

    {
      name: 'compact-noop-without-summarizer',
      kind: 'compact',
      label: 'compact-off',
      setup: () => ({
        messages: compactProtectMessages(),
        context: makeCompactContext({ withSummarizer: false }),
      }),
      checks: [compactOutcomeIs('noop'), compactReasonIs('no_summarizer')],
    },

    {
      name: 'compact-protects-error-unit',
      kind: 'compact',
      label: 'compact-protect',
      setup: () => ({
        messages: compactProtectMessages(),
        context: makeCompactContext(),
        turn: 1,
      }),
      checks: [
        compactOutcomeIs('compacted'),
        compactProtectedUnitsAtLeast(1),
        afterCompactKeepsToolCallId('d1'),
        compactRemovedToolResultsAtLeast(1),
      ],
    },

    {
      name: 'compact-folds-write-when-unprotected',
      kind: 'compact',
      label: 'compact-narrow-protect',
      setup: () => ({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'Goal: ship', kind: 'goal' },
          {
            role: 'assistant',
            toolCalls: [{ id: 'w1', name: 'write', arguments: {} }],
          },
          {
            role: 'tool',
            name: 'write',
            toolCallId: 'w1',
            content: 'wrote-file-ok',
            untrusted: true,
          },
          {
            role: 'assistant',
            toolCalls: [{ id: 'r1', name: 'read', arguments: {} }],
          },
          {
            role: 'tool',
            name: 'read',
            toolCallId: 'r1',
            content: 'file-body-'.repeat(8),
            untrusted: true,
          },
          { role: 'assistant', content: 'recent-a' },
          { role: 'user', content: 'recent-u' },
        ],
        context: makeCompactContext({ protectVerbatimClasses: ['tool_error'] }),
        turn: 1,
      }),
      checks: [
        compactOutcomeIs('compacted'),
        afterCompactDropsToolCallId('w1'),
        compactRemovedToolResultsAtLeast(1),
      ],
    },

    {
      name: 'retrieval-injects-high-score-untrusted',
      label: 'retrieval',
      setup: () => {
        const tools = new MockToolInvoker([demoGetIssue]);
        const model = new ScriptedChatModel([finalResponse('done')]);
        return {
          goal: 'x',
          model,
          tools,
          retrieval: {
            hits: [
              { id: 'good', text: 'ALPHA_HIT evidence', score: 0.9 },
              { id: 'bad', text: 'BETA_NOISE junk', score: 0.1 },
            ],
            inject: { minScore: 0.5 },
          },
        };
      },
      checks: [
        runFinished(),
        retrievalMessageCountIs(1),
        retrievalStaysUntrusted(),
        messageContentIncludes('ALPHA_HIT'),
        noMessageContentIncludes('BETA_NOISE'),
      ],
    },

    {
      name: 'retrieval-gate-drops-low-scores',
      label: 'retrieval',
      setup: () => {
        const tools = new MockToolInvoker([demoGetIssue]);
        const model = new ScriptedChatModel([finalResponse('done')]);
        return {
          goal: 'x',
          model,
          tools,
          retrieval: {
            hits: [{ id: 'bad', text: 'BETA_NOISE junk', score: 0.1 }],
            inject: { minScore: 0.5 },
          },
        };
      },
      checks: [runFinished(), retrievalMessageCountIs(0), noMessageContentIncludes('BETA_NOISE')],
    },

    {
      name: 'scratchpad-offloads-large-result',
      label: 'scratchpad',
      setup: () => {
        const inner = new MockToolInvoker([demoBigRead]);
        const tools = new ScratchpadToolInvoker(inner, { offloadThreshold: 4000, previewChars: 40 });
        const model = new ScriptedChatModel([
          toolCallResponse([toolCall('c1', 'bigRead', { path: 'blob.bin' })]),
          finalResponse('done'),
        ]);
        return { goal: 'x', model, tools };
      },
      checks: [runFinished(), scratchpadOffloaded(), toolResultsUntrusted()],
    },

    {
      name: 'scratchpad-never-offload-list',
      label: 'scratchpad',
      setup: () => {
        const inner = new MockToolInvoker([demoBigRead]);
        const tools = new ScratchpadToolInvoker(inner, {
          offloadThreshold: 4000,
          neverOffload: ['bigRead'],
        });
        const model = new ScriptedChatModel([
          toolCallResponse([toolCall('c1', 'bigRead', { path: 'blob.bin' })]),
          finalResponse('done'),
        ]);
        return { goal: 'x', model, tools };
      },
      checks: [runFinished(), scratchpadNotOffloaded(), messageContentIncludes('XXXX')],
    },

    {
      name: 'loop-sequence-ab-ab-trips',
      label: 'loop-profile',
      setup: () => {
        const tools = new MockToolInvoker([demoGetIssue, demoSearchCode]);
        const model = new ScriptedChatModel([
          toolCallResponse([toolCall('c1', 'getIssue', { issue: 'same' })]),
          toolCallResponse([toolCall('c2', 'searchCode', { query: 'same' })]),
          toolCallResponse([toolCall('c3', 'getIssue', { issue: 'same' })]),
          toolCallResponse([toolCall('c4', 'searchCode', { query: 'same' })]),
          finalResponse('unreachable'),
        ]);
        return {
          goal: 'x',
          model,
          tools,
          maxTurns: 20,
          loopOptions: {
            limit: 99,
            sequenceDetection: true,
            sequenceLengths: [2],
            sequenceLimit: 2,
          },
        };
      },
      checks: [stopReasonIs('loop_detected')],
    },

    {
      name: 'loop-advisory-nudges-without-abort',
      label: 'loop-profile',
      setup: () => {
        const tools = new MockToolInvoker([demoGetIssue]);
        const model = new ScriptedChatModel([
          toolCallResponse([toolCall('c1', 'getIssue', { issue: 'same' })]),
          toolCallResponse([toolCall('c2', 'getIssue', { issue: 'same' })]),
          toolCallResponse([toolCall('c3', 'getIssue', { issue: 'same' })]),
          finalResponse('changed approach'),
        ]);
        return {
          goal: 'x',
          model,
          tools,
          maxTurns: 10,
          loopOptions: { limit: 3, advisoryTools: ['getIssue'] },
        };
      },
      checks: [runFinished(), messageContentIncludes('repeatedly'), answerContains('changed')],
    },

    approverCountsSensitiveToolsScenario(),
  ];
}
