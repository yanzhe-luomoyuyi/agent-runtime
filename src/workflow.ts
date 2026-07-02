/**
 * Workflow definition — a declarative list of phases, each with ordered steps.
 *
 * A step is a plain async function that receives a `StepContext`: the current
 * derived state, the model, and an idempotent `callTool` helper. Steps read the
 * outputs of earlier steps via `getStepOutput`. Keeping the workflow declarative
 * (data, not control flow) is what lets the runtime resume it generically.
 *
 * The demo workflow is intentionally thin (analyze -> locate -> propose). It is
 * just a workload to exercise the platform; the durability/idempotency/replay
 * machinery is the actual product.
 */

import type { ToolRegistry } from './tools/registry.js';
import type { RunState } from './types.js';

export interface StepContext {
  runId: string;
  input: { issue: string };
  state: RunState;
  tools: ToolRegistry;
  /** Call a tool with automatic, deterministic idempotency across resumes. */
  callTool: <R = unknown>(tool: string, args: unknown) => Promise<R>;
  /** Call the model; recorded as a ModelCalled event (tokens/cost/latency) and idempotent across resumes. */
  callModel: (prompt: string) => Promise<string>;
  /** Read the output an earlier step produced (e.g. "analyze.1"). */
  getStepOutput: <R = unknown>(stepId: string) => R | undefined;
}

export interface StepDef {
  id: string;
  name: string;
  run: (ctx: StepContext) => Promise<unknown>;
}

export interface PhaseDef {
  name: string;
  skippable: boolean;
  steps: StepDef[];
}

export interface WorkflowDef {
  name: string;
  phases: PhaseDef[];
}

interface IssueRecord {
  title: string;
  body: string;
  labels: string[];
}

export const issueWorkflow: WorkflowDef = {
  name: 'issue-fix',
  phases: [
    {
      name: 'analyze',
      skippable: false,
      steps: [
        {
          id: 'analyze.1',
          name: 'Fetch issue',
          run: (ctx) => ctx.callTool<IssueRecord>('getIssue', { issue: ctx.input.issue }),
        },
        {
          id: 'analyze.2',
          name: 'Summarize',
          run: async (ctx) => {
            const issue = ctx.getStepOutput<IssueRecord>('analyze.1')!;
            const summary = await ctx.callModel(
              `[analyze.summary] Summarize this issue and list keywords: ${issue.title} — ${issue.body}`,
            );
            return { summary, labels: issue.labels };
          },
        },
      ],
    },
    {
      name: 'locate',
      skippable: false,
      steps: [
        {
          id: 'locate.1',
          name: 'Search code',
          run: async (ctx) => {
            const issue = ctx.getStepOutput<IssueRecord>('analyze.1')!;
            const { files } = await ctx.callTool<{ files: string[] }>('searchCode', {
              query: `${issue.title} ${issue.body}`,
            });
            return { candidateFiles: files };
          },
        },
      ],
    },
    {
      name: 'propose',
      skippable: false,
      steps: [
        {
          id: 'propose.1',
          name: 'Propose fix',
          run: async (ctx) => {
            const analysis = ctx.getStepOutput<{ summary: string }>('analyze.2')!;
            const located = ctx.getStepOutput<{ candidateFiles: string[] }>('locate.1')!;
            const proposal = await ctx.callModel(
              `[propose.fix] Given summary "${analysis.summary}" and candidate files ` +
                `${located.candidateFiles.join(', ')}, propose a concrete fix.`,
            );
            return { proposal, files: located.candidateFiles };
          },
        },
      ],
    },
  ],
};
