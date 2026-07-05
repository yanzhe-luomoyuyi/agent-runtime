/**
 * Demo workflow — the "issue → fix" agent, expressed as a declarative list of
 * phases and ordered steps (analyze -> locate -> propose).
 *
 * This is the *workload* that exercises the runtime, not the runtime itself.
 * The platform (event log, reducer, idempotent replay, resume) lives under src/
 * and knows nothing about issues or fixes — it just drives whatever `WorkflowDef`
 * it is handed. Each step is a plain async function that receives a `StepContext`
 * (the runtime's contract) and reads earlier steps' outputs via `getStepOutput`.
 * To run a different agent, swap this file together with ./tools and ./responses.
 */

import type { WorkflowDef } from '../workflow.js';

import type { IssueRecord } from './tools.js';

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
