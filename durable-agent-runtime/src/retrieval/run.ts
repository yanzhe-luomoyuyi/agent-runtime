/**
 * System-initiated retrieve — the default `once` / `once_rewrite` / `capped_agentic`
 * path for a general engine.
 *
 * Prefer going through `callTool('document_search', …)` when the tool is
 * registered so the read is event-logged and replay-safe. `systemRetrieveOnce`
 * covers the direct Retriever path (unit tests / hosts without a tool registry).
 * `systemRetrieveForStep` is the durable orchestration: corpus resolve, optional
 * rewrite, tool-or-retriever search, shared maxRetrieves budget.
 */

import type { CorpusScoped } from '@agent/contracts';
import { keyScope } from '@agent/contracts';

import { collectSkillCorpora, resolveRunCorpusId } from './corpus.js';
import {
  countDocumentSearchesInState,
  resolveRetrievalPolicy,
  RetrievalBudget,
  wantsSystemRetrieve,
} from './policy.js';
import type { Retriever } from './retriever.js';
import { DOCUMENT_SEARCH_TOOL } from './tools.js';
import type { RetrievalHit, RetrievalPolicy, ResolvedRetrievalPolicy } from './types.js';
import type { RunState } from '../types.js';

export interface SystemRetrieveOptions {
  retriever: Retriever;
  policy?: RetrievalPolicy;
  query: string;
  corpusId: string;
  /** Optional shared budget (e.g. when agentic calls share the same counter). */
  budget?: RetrievalBudget;
}

export interface SystemRetrieveResult {
  hits: RetrievalHit[];
  policy: ResolvedRetrievalPolicy;
  retrievesUsed: number;
  /** True when a retrieve was attempted (budget permitting). */
  retrieved: boolean;
  skippedReason?: 'off' | 'corpus_denied' | 'budget_exhausted';
}

/** Run at most one system retrieve under the resolved policy. */
export async function systemRetrieveOnce(opts: SystemRetrieveOptions): Promise<SystemRetrieveResult> {
  const policy = resolveRetrievalPolicy(opts.policy);
  if (!wantsSystemRetrieve(policy)) {
    return { hits: [], policy, retrievesUsed: 0, retrieved: false, skippedReason: 'off' };
  }
  if (policy.corpora && !policy.corpora.includes(opts.corpusId)) {
    return { hits: [], policy, retrievesUsed: 0, retrieved: false, skippedReason: 'corpus_denied' };
  }

  const budget = opts.budget ?? new RetrievalBudget(policy.maxRetrieves);
  if (!budget.tryConsume()) {
    return {
      hits: [],
      policy,
      retrievesUsed: budget.retrievesUsed,
      retrieved: false,
      skippedReason: 'budget_exhausted',
    };
  }

  const hits = await opts.retriever.search({
    corpusId: opts.corpusId,
    query: opts.query,
    limit: policy.maxChunks,
    mode: policy.rankMode,
  });

  return { hits, policy, retrievesUsed: budget.retrievesUsed, retrieved: true };
}

/** Minimal durable seam for system retrieve (avoids importing StepContext). */
export interface SystemRetrieveSeam {
  state: RunState;
  listToolNames: () => string[];
  callTool: <R = unknown>(tool: string, args: unknown, opts?: { key?: string }) => Promise<R>;
  callModel: (prompt: string, opts?: { key?: string }) => Promise<string>;
}

export interface SystemRetrieveForStepOptions {
  seam: SystemRetrieveSeam;
  /** User goal / issue text used as the search query (or rewrite input). */
  goal: string;
  retrieval: {
    corpusId?: string;
    retriever?: Retriever;
  };
  policy: ResolvedRetrievalPolicy;
  skills?: readonly CorpusScoped[];
  documentSearchTool?: string;
}

/**
 * Prefer durable `document_search` (event-logged); fall back to a direct
 * Retriever when the tool is not registered (unit / non-durable hosts).
 * Counts against the same maxRetrieves budget as agentic searches.
 *
 * `once_rewrite`: keyed model rewrite of the goal, then a single search.
 */
export async function systemRetrieveForStep(
  opts: SystemRetrieveForStepOptions,
): Promise<RetrievalHit[] | undefined> {
  const { seam, goal, retrieval, policy, skills } = opts;
  const searchTool = opts.documentSearchTool ?? DOCUMENT_SEARCH_TOOL;
  if (!wantsSystemRetrieve(policy)) return undefined;

  const skillCorpora = collectSkillCorpora(skills);
  const allowed = policy.corpora ?? (skillCorpora.length > 0 ? skillCorpora : undefined);
  let corpusId: string;
  try {
    corpusId = resolveRunCorpusId({
      corpusId: retrieval.corpusId,
      skills,
      allowedCorpora: allowed,
    });
  } catch {
    return undefined;
  }

  let query = goal;
  if (policy.mode === 'once_rewrite') {
    query = await rewriteQueryForRetrieve(seam, goal);
  }

  const hasTool = seam.listToolNames().includes(searchTool);
  if (hasTool) {
    if (countDocumentSearchesInState(seam.state, searchTool) >= policy.maxRetrieves) {
      return undefined;
    }
    const raw = await seam.callTool<unknown>(
      searchTool,
      {
        query,
        limit: policy.maxChunks,
        mode: policy.rankMode,
        // Multi-corpus tools accept corpusId; single-corpus tools ignore unknown props.
        corpusId,
      },
      { key: keyScope().retrieveOnce() },
    );
    if (typeof raw === 'string' && raw.startsWith('ERROR:')) return undefined;
    return normalizeSearchHits(raw);
  }

  if (!retrieval.retriever) return undefined;
  const budget = new RetrievalBudget(policy.maxRetrieves);
  budget.seedUsed(countDocumentSearchesInState(seam.state, searchTool));
  const result = await systemRetrieveOnce({
    retriever: retrieval.retriever,
    policy,
    query,
    corpusId,
    budget,
  });
  return result.retrieved ? result.hits : undefined;
}

/** Cheap rewrite for once_rewrite — durable via keyed callModel. */
export async function rewriteQueryForRetrieve(seam: Pick<SystemRetrieveSeam, 'callModel'>, goal: string): Promise<string> {
  const prompt = [
    'Rewrite the user goal into a short keyword search query for a document corpus.',
    'Reply with ONLY the search query text — no quotes, no explanation, no punctuation wrappers.',
    '',
    `Goal: ${goal}`,
  ].join('\n');
  const text = await seam.callModel(prompt, { key: keyScope().retrieveRewrite() });
  const line = text.trim().split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
  // Strip wrapping quotes if the model adds them.
  const cleaned = line.replace(/^["'`]+|["'`]+$/g, '').trim();
  return cleaned || goal;
}

/** Convert `document_search` tool output into RetrievalHit[]. */
export function normalizeSearchHits(raw: unknown): RetrievalHit[] {
  if (!Array.isArray(raw)) return [];
  const hits: RetrievalHit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as { id?: unknown; text?: unknown; score?: unknown; metadata?: unknown };
    if (typeof o.id !== 'string' || typeof o.text !== 'string') continue;
    hits.push({
      id: o.id,
      text: o.text,
      score: typeof o.score === 'number' ? o.score : 0,
      metadata: o.metadata && typeof o.metadata === 'object' ? (o.metadata as Record<string, unknown>) : undefined,
    });
  }
  return hits;
}

export {
  countDocumentSearchesInState,
  documentSearchBudgetExhaustedMessage,
  checkDocumentSearchBudget,
  exposeRetrievalToolsToModel,
  resolveRetrievalPolicy,
  RetrievalBudget,
  wantsSystemRetrieve,
} from './policy.js';
