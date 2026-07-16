/**
 * D: result aggregation for fan-out sub-agent calls.
 *
 * When a parent turn delegates to multiple sub-agents in parallel (see
 * `subagent.ts`), the raw `answer: string` from each call should not be
 * concatenated verbatim back into the parent's context — that wastes tokens,
 * forces the model to re-derive a summary it already computed once, and
 * degrades badly as the number of sub-agents grows ("lost in the middle").
 *
 * Three composable strategies, in increasing order of LLM involvement:
 *
 *  - `mapReduce`         — pure-code merge of structured (schema-validated)
 *                          results. Zero LLM calls; use when sub-agents answer
 *                          *different*, complementary questions (e.g.
 *                          "front-end" + "back-end" + "database").
 *  - `aggregateVotes`    — majority-vote consensus across sub-agents that
 *                          answered the *same* question independently (à la
 *                          Self-Consistency). Surfaces the dissenting minority
 *                          and an agreement ratio instead of silently
 *                          discarding disagreement.
 *  - `hierarchicalMerge` — pairwise, tree-shaped merge for large fan-outs
 *                          (e.g. 20+ sub-agents). Each layer's merges run
 *                          concurrently; no single merge step ever sees more
 *                          than `groupSize` results at once, which sidesteps
 *                          both context-window limits and the "lost in the
 *                          middle" degradation of stuffing everything into one
 *                          prompt.
 *
 * All three are plain, host-agnostic functions — no IO, no model calls baked
 * in (`mergeFn`/`keyFn`/`reduceFn` are supplied by the caller) — so they
 * compose with `makeSubagentTool` without either module depending on the
 * other.
 */

/** Pure-code merge of structured sub-agent results. Never calls a model. */
export function mapReduce<T, R>(results: T[], reduceFn: (results: T[]) => R): R {
  return reduceFn(results);
}

export interface VoteResult<T> {
  /** The majority result (first member of the largest agreeing group). */
  consensus: T;
  /** Fraction of results that agreed with `consensus`, in (0, 1]. */
  agreement: number;
  /** All results that did NOT match the consensus group — never discarded. */
  dissenting: T[];
  /** Convenience bucketing of `agreement` for callers that want a quick signal. */
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Group independent sub-agent answers to the *same* question by a
 * caller-supplied key (e.g. a normalized verdict) and return the majority
 * group plus the dissenting minority. Ties break toward the first group that
 * reached the winning size.
 */
export function aggregateVotes<T>(results: T[], keyFn: (result: T) => string): VoteResult<T> {
  if (results.length === 0) {
    throw new Error('aggregateVotes: results must be non-empty');
  }

  const groups = new Map<string, T[]>();
  for (const r of results) {
    const k = keyFn(r);
    const group = groups.get(k);
    if (group) group.push(r);
    else groups.set(k, [r]);
  }

  let majority: T[] = [];
  for (const group of groups.values()) {
    if (group.length > majority.length) majority = group;
  }

  const agreement = majority.length / results.length;
  const majoritySet = new Set(majority);
  const dissenting = results.filter((r) => !majoritySet.has(r));

  return {
    consensus: majority[0]!,
    agreement,
    dissenting,
    confidence: agreement > 0.8 ? 'high' : agreement > 0.5 ? 'medium' : 'low',
  };
}

/**
 * Pairwise tree merge: repeatedly merges adjacent groups of up to `groupSize`
 * items until one remains. Each layer's merges run concurrently (they are
 * independent), so growing the fan-out only adds *rounds*
 * (≈ log_groupSize(n)), not serial LLM calls, versus a naive one-shot merge
 * of every result into a single prompt.
 */
export async function hierarchicalMerge<T>(items: T[], mergeFn: (a: T, b: T) => Promise<T>, groupSize = 2): Promise<T> {
  if (items.length === 0) {
    throw new Error('hierarchicalMerge: items must be non-empty');
  }
  if (groupSize < 2) {
    throw new Error('hierarchicalMerge: groupSize must be >= 2');
  }

  let layer = items;
  while (layer.length > 1) {
    const tasks: Promise<T>[] = [];
    for (let i = 0; i < layer.length; i += groupSize) {
      const group = layer.slice(i, i + groupSize);
      tasks.push(group.length === 1 ? Promise.resolve(group[0]!) : foldGroup(group, mergeFn));
    }
    layer = await Promise.all(tasks);
  }
  return layer[0]!;
}

/** Fold one group of items pairwise through `mergeFn` (sequential within the group; groups themselves run in parallel). */
async function foldGroup<T>(group: T[], mergeFn: (a: T, b: T) => Promise<T>): Promise<T> {
  return foldFrom(group[0] as T, group.slice(1), mergeFn);
}

async function foldFrom<T>(acc: T, rest: T[], mergeFn: (a: T, b: T) => Promise<T>): Promise<T> {
  for (const item of rest) {
    acc = await mergeFn(acc, item);
  }
  return acc;
}
