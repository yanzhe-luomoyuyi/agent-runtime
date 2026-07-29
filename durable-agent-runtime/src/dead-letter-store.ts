/**
 * Disk-backed dead-letter queue — a durable last-resort record for tool calls
 * that failed even after reaching the runtime's tool funnel (see `runtime.ts`'s
 * `callTool`). Implements `@agent/contracts`'s `DeadLetterQueue` interface so
 * harness `retryDeadLetter()` and the runtime funnel share one letter shape.
 *
 * One JSON file for the whole queue, written atomically (tmp + rename) — same
 * convention as `memory/store.ts`'s `FileMemoryStore`. A corrupt file is
 * treated as an empty queue rather than crashing the run.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { DeadLetter, DeadLetterQueue } from '@agent/contracts';

export class FileDeadLetterQueue implements DeadLetterQueue {
  constructor(private readonly filePath: string) {}

  private load(): DeadLetter[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as DeadLetter[]) : [];
    } catch {
      return []; // corrupt file → treat as empty (never crash the run)
    }
  }

  private persist(letters: DeadLetter[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(letters));
      renameSync(tmp, this.filePath);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
      throw e;
    }
  }

  push(letter: DeadLetter): void {
    const letters = this.load();
    const idx = letters.findIndex((l) => l.id === letter.id);
    if (idx >= 0) letters[idx] = letter; // upsert in place (idempotent, same as FileMemoryStore.write)
    else letters.push(letter);
    this.persist(letters);
  }

  get(id: string): DeadLetter | undefined {
    return this.load().find((l) => l.id === id);
  }

  list(): DeadLetter[] {
    return this.load();
  }

  remove(id: string): boolean {
    const letters = this.load();
    const next = letters.filter((l) => l.id !== id);
    if (next.length === letters.length) return false;
    this.persist(next);
    return true;
  }
}
