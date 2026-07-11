/**
 * Cross-session memory store — durable, scoped knowledge that outlives a run.
 *
 * This is the RUNTIME's concern, not the harness's: it is persistent, mutable,
 * cross-run state, whereas the harness is stateless and per-run. Memories are
 * curated facts / preferences / notes the agent deliberately writes — NOT a
 * dump of past transcripts. They are surfaced to the model as ordinary tools
 * (see app/memory-tools.ts); routing those tools through `ctx.callTool` is what
 * records each read in the run's event log and keeps replay deterministic.
 *
 * ## Independence from the run event log
 *
 * The memory store is a SEPARATE artifact from the per-run event logs:
 *  - per-run log: append-only, immutable, one run, exists for deterministic replay;
 *  - memory store: cross-run, MUTABLE (update / delete / TTL), scoped to a
 *    user/project, exists for durable knowledge.
 * Mixing them would break the "one run log = deterministic replay of one run"
 * invariant, so memory lives on its own.
 *
 * ## Idempotent writes
 *
 * Auto-assigned ids are CONTENT-ADDRESSED (a hash of the text). If a crash lands
 * between the store write and the event-log append, resume re-runs the write —
 * but the same text yields the same id and upserts in place, so no duplicate
 * record appears. Callers may pass an explicit `id` to update an existing memory.
 *
 * ## Scope
 *
 * Every operation takes a `scope` (e.g. a user or project id). Scoping is
 * enforced here (one file per sanitised scope) rather than trusted to callers,
 * so memories cannot leak across users.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { rankByRelevance } from './lexical.js';

export type MemoryKind = 'semantic' | 'episodic' | 'procedural';

/** One durable memory. */
export interface MemoryRecord {
  id: string;
  text: string;
  tags: string[];
  /** semantic = facts, episodic = past events, procedural = how-to. */
  kind: MemoryKind;
}

export interface MemoryWriteOptions {
  /** Explicit id to update an existing memory. Default: content-addressed. */
  id?: string;
  tags?: string[];
  kind?: MemoryKind;
}

export interface MemoryQueryOptions {
  limit?: number;
  tags?: string[];
  kind?: MemoryKind;
}

/** The persistence seam. Every op is scoped so memories cannot cross users. */
export interface MemoryStore {
  write(scope: string, text: string, opts?: MemoryWriteOptions): MemoryRecord;
  read(scope: string, id: string): MemoryRecord | undefined;
  search(scope: string, query: string, opts?: MemoryQueryOptions): MemoryRecord[];
  list(scope: string, opts?: MemoryQueryOptions): MemoryRecord[];
  /** Reserved for TTL / correction workflows. Returns true if a record was removed. */
  delete(scope: string, id: string): boolean;
}

/** FNV-1a — a tiny deterministic string hash (zero-dep) for content-addressed ids. */
function contentId(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `mem-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/** Shared query/write logic; subclasses provide load/persist. */
abstract class BaseMemoryStore implements MemoryStore {
  protected abstract load(scope: string): MemoryRecord[];
  protected abstract persist(scope: string, records: MemoryRecord[]): void;

  write(scope: string, text: string, opts: MemoryWriteOptions = {}): MemoryRecord {
    const records = this.load(scope);
    const id = opts.id ?? contentId(text);
    const record: MemoryRecord = { id, text, tags: opts.tags ?? [], kind: opts.kind ?? 'semantic' };
    const idx = records.findIndex((r) => r.id === id);
    if (idx >= 0) records[idx] = record; // upsert in place (idempotent)
    else records.push(record);
    this.persist(scope, records);
    return record;
  }

  read(scope: string, id: string): MemoryRecord | undefined {
    return this.load(scope).find((r) => r.id === id);
  }

  search(scope: string, query: string, opts: MemoryQueryOptions = {}): MemoryRecord[] {
    const pool = filterRecords(this.load(scope), opts);
    return rankByRelevance(query, pool, (r) => `${r.text} ${r.tags.join(' ')}`, opts.limit ?? 5).map((s) => s.item);
  }

  list(scope: string, opts: MemoryQueryOptions = {}): MemoryRecord[] {
    return filterRecords(this.load(scope), opts); // insertion order (file order)
  }

  delete(scope: string, id: string): boolean {
    const records = this.load(scope);
    const next = records.filter((r) => r.id !== id);
    if (next.length === records.length) return false;
    this.persist(scope, next);
    return true;
  }
}

function filterRecords(records: MemoryRecord[], opts: MemoryQueryOptions): MemoryRecord[] {
  let pool = records;
  if (opts.kind) pool = pool.filter((r) => r.kind === opts.kind);
  if (opts.tags && opts.tags.length > 0) pool = pool.filter((r) => opts.tags!.some((t) => r.tags.includes(t)));
  return pool;
}

/** Non-persistent store — for tests and plain (non-durable) hosts. */
export class InMemoryStore extends BaseMemoryStore {
  private readonly scopes = new Map<string, MemoryRecord[]>();
  protected load(scope: string): MemoryRecord[] {
    return [...(this.scopes.get(scope) ?? [])];
  }
  protected persist(scope: string, records: MemoryRecord[]): void {
    this.scopes.set(scope, records);
  }
}

/** Disk-backed store: one JSON file per scope, written atomically (tmp + rename). */
export class FileMemoryStore extends BaseMemoryStore {
  constructor(private readonly baseDir: string) {
    super();
  }

  private file(scope: string): string {
    const safe = scope.replace(/[^a-zA-Z0-9_.-]/g, '_') || '_default';
    return join(this.baseDir, `${safe}.json`);
  }

  protected load(scope: string): MemoryRecord[] {
    const path = this.file(scope);
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as MemoryRecord[]) : [];
    } catch {
      return []; // corrupt file → treat as empty (never crash the run)
    }
  }

  protected persist(scope: string, records: MemoryRecord[]): void {
    mkdirSync(this.baseDir, { recursive: true });
    const dst = this.file(scope);
    const tmp = `${dst}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(records));
      renameSync(tmp, dst);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      throw e;
    }
  }
}
