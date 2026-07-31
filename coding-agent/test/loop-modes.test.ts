/**
 * Planner / reflection loop modes through createCodingRuntime.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autoApprove } from '@agent/harness';
import { extractCritiques, extractPlan } from 'durable-agent-runtime';
import { describe, expect, it } from 'vitest';

import { loadCodingConfig } from '../src/config.js';
import { createCodingRuntime } from '../src/runtime-factory.js';
import { finalTurn, ScriptedChatProvider, toolTurn } from './scripted-chat.js';

describe('loop modes', () => {
  it('planner mode stores the final plan on the step output', async () => {
    const work = mkdtempSync(join(tmpdir(), 'coding-plan-ws-'));
    const runs = mkdtempSync(join(tmpdir(), 'coding-plan-runs-'));
    const cfg = loadCodingConfig({ skipEnv: true });

    // 1) makePlan (tools:[]) → JSON steps
    // 2) execute step 1 → finish
    // 3) execute step 2 → finish
    const chatModel = new ScriptedChatProvider([
      finalTurn('{"steps":["Inspect workspace layout","Write a short summary"]}'),
      finalTurn('Inspected the workspace.'),
      finalTurn('Summary: empty workspace ready for coding.'),
    ]);

    try {
      const rt = createCodingRuntime({
        baseDir: runs,
        workspaceRoot: work,
        chatModel,
        approver: autoApprove,
        autoApproveWrites: true,
        loopMode: 'planner',
        config: cfg,
        maxTurns: 8,
        stream: false,
      });
      const state = await rt.run('Summarize this repo layout');
      expect(state.status).toBe('completed');
      const plan = extractPlan(state) as {
        steps: string[];
        statuses: string[];
      };
      expect(plan.steps).toEqual(['Inspect workspace layout', 'Write a short summary']);
      expect(plan.statuses).toEqual(['completed', 'completed']);
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(runs, { recursive: true, force: true });
    }
  }, 30_000);

  it('reflection mode records critiques', async () => {
    const work = mkdtempSync(join(tmpdir(), 'coding-reflect-ws-'));
    const runs = mkdtempSync(join(tmpdir(), 'coding-reflect-runs-'));
    const cfg = loadCodingConfig({ skipEnv: true });
    cfg.run.reflection = { maxReflections: 1 };

    // attempt 0 → answer; critique → satisfactory
    const chatModel = new ScriptedChatProvider([
      finalTurn('The answer is 42.'),
      finalTurn('{"satisfactory":true,"feedback":"Looks complete."}'),
    ]);

    try {
      const rt = createCodingRuntime({
        baseDir: runs,
        workspaceRoot: work,
        chatModel,
        approver: autoApprove,
        autoApproveWrites: true,
        loopMode: 'reflection',
        config: cfg,
        maxTurns: 8,
        stream: false,
      });
      const state = await rt.run('What is the answer?');
      expect(state.status).toBe('completed');
      const critiques = extractCritiques(state) as Array<{ satisfactory: boolean; feedback: string }>;
      expect(critiques?.length).toBe(1);
      expect(critiques[0]!.satisfactory).toBe(true);
      expect(critiques[0]!.feedback).toMatch(/complete|Looks/i);
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(runs, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps memory tools usable under planner mode', async () => {
    const work = mkdtempSync(join(tmpdir(), 'coding-plan-mem-'));
    const runs = mkdtempSync(join(tmpdir(), 'coding-plan-mem-runs-'));
    const memDir = mkdtempSync(join(tmpdir(), 'coding-plan-mem-store-'));
    const cfg = loadCodingConfig({ skipEnv: true });
    cfg.run.memory = { enabled: true, storeDir: memDir };

    const chatModel = new ScriptedChatProvider([
      finalTurn('{"steps":["Write a memory note"]}'),
      toolTurn([{ name: 'memory_write', arguments: { text: 'use planner with memory' } }]),
      finalTurn('noted'),
    ]);

    try {
      const rt = createCodingRuntime({
        baseDir: runs,
        workspaceRoot: work,
        chatModel,
        approver: autoApprove,
        autoApproveWrites: true,
        loopMode: 'planner',
        longTermMemory: true,
        config: cfg,
        maxTurns: 8,
      });
      const state = await rt.run('Remember to use planner with memory');
      expect(state.status).toBe('completed');
      expect(extractPlan(state)).toBeTruthy();
    } finally {
      rmSync(work, { recursive: true, force: true });
      rmSync(runs, { recursive: true, force: true });
      rmSync(memDir, { recursive: true, force: true });
    }
  }, 30_000);
});
