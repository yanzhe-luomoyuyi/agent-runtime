import { describe, expect, it } from 'vitest';

import { aggregateVotes, hierarchicalMerge, mapReduce } from '../src/control/aggregate.js';

describe('aggregate', () => {
  describe('mapReduce', () => {
    it('runs the reducer over the full result set with no async/model involvement', () => {
      const results = [
        { dimension: 'frontend', severity: 3, affectedUsers: 12000 },
        { dimension: 'backend', severity: 2, affectedUsers: 3000 },
        { dimension: 'database', severity: 5, affectedUsers: 45000 },
      ];

      const report = mapReduce(results, (rs) => ({
        totalAffectedUsers: rs.reduce((sum, r) => sum + r.affectedUsers, 0),
        topPriority: rs.reduce((max, r) => (r.severity > max.severity ? r : max)),
      }));

      expect(report.totalAffectedUsers).toBe(60000);
      expect(report.topPriority.dimension).toBe('database');
    });
  });

  describe('aggregateVotes', () => {
    it('returns the majority verdict, agreement ratio, and dissenting minority', () => {
      const verdicts = ['vulnerable', 'vulnerable', 'safe'];
      const result = aggregateVotes(verdicts, (v) => v);

      expect(result.consensus).toBe('vulnerable');
      expect(result.agreement).toBeCloseTo(2 / 3);
      expect(result.dissenting).toEqual(['safe']);
      expect(result.confidence).toBe('medium');
    });

    it('reports high confidence on unanimous agreement', () => {
      const result = aggregateVotes(['a', 'a', 'a'], (v) => v);
      expect(result.agreement).toBe(1);
      expect(result.dissenting).toEqual([]);
      expect(result.confidence).toBe('high');
    });

    it('groups by a derived key, not by reference equality', () => {
      const results = [{ verdict: 'fail' }, { verdict: 'fail' }, { verdict: 'pass' }];
      const result = aggregateVotes(results, (r) => r.verdict);
      expect(result.consensus.verdict).toBe('fail');
      expect(result.dissenting).toHaveLength(1);
      expect(result.dissenting[0]!.verdict).toBe('pass');
    });

    it('throws on an empty result set', () => {
      expect(() => aggregateVotes([], (v) => String(v))).toThrow(/non-empty/);
    });
  });

  describe('hierarchicalMerge', () => {
    it('merges pairwise across layers until one item remains', async () => {
      const merges: string[] = [];
      const mergeFn = async (a: string, b: string) => {
        merges.push(`${a}+${b}`);
        return `(${a}+${b})`;
      };

      const result = await hierarchicalMerge(['R1', 'R2', 'R3', 'R4'], mergeFn);

      expect(result).toBe('((R1+R2)+(R3+R4))');
      // Layer 1: two independent merges; layer 2: one merge of the two layer-1 results.
      expect(merges).toEqual(['R1+R2', 'R3+R4', '(R1+R2)+(R3+R4)']);
    });

    it('carries a lone leftover item forward unmerged', async () => {
      const mergeFn = async (a: string, b: string) => `(${a}+${b})`;
      const result = await hierarchicalMerge(['R1', 'R2', 'R3'], mergeFn);
      expect(result).toBe('((R1+R2)+R3)');
    });

    it('returns the single item unchanged without calling mergeFn', async () => {
      const mergeFn = async (a: string, b: string) => `(${a}+${b})`;
      const result = await hierarchicalMerge(['only'], mergeFn);
      expect(result).toBe('only');
    });

    it('respects a custom groupSize', async () => {
      const merges: string[][] = [];
      const mergeFn = async (a: string, b: string) => {
        merges.push([a, b]);
        return `${a},${b}`;
      };
      // groupSize=3 folds three items sequentially per group via mergeFn pairs.
      const result = await hierarchicalMerge(['R1', 'R2', 'R3'], mergeFn, 3);
      expect(result).toBe('R1,R2,R3');
      expect(merges).toEqual([['R1', 'R2'], ['R1,R2', 'R3']]);
    });

    it('throws on an empty item list', async () => {
      await expect(hierarchicalMerge<string>([], async (a, b) => `${a}${b}`)).rejects.toThrow(/non-empty/);
    });

    it('throws on groupSize < 2', async () => {
      await expect(hierarchicalMerge(['a', 'b'], async (a, b) => `${a}${b}`, 1)).rejects.toThrow(/groupSize/);
    });
  });
});
