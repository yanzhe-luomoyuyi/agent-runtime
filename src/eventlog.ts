/**
 * Append-only event log with JSONL persistence.
 *
 * Each event is written as one line and flushed immediately, so a crash at any
 * point leaves a valid, replayable prefix on disk (durability). One file per
 * run: `<baseDir>/<runId>.jsonl`.
 *
 * This deliberately mirrors how a production system would use a write-ahead log
 * or an event store — but with zero dependencies so the demo runs anywhere.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { AgentEvent } from './types.js';

export class EventLog {
  private readonly events: AgentEvent[] = [];

  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      const lines = readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
      this.events = lines.map((line) => JSON.parse(line) as AgentEvent);
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
    }
  }

  all(): AgentEvent[] {
    return [...this.events];
  }

  append(event: AgentEvent): void {
    this.events.push(event);
    appendFileSync(this.filePath, JSON.stringify(event) + '\n');
  }

  get length(): number {
    return this.events.length;
  }
}

export function runLogPath(baseDir: string, runId: string): string {
  return join(baseDir, `${runId}.jsonl`);
}
