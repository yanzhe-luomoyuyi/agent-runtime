/**
 * Dead-letter queue — shared persistence seam for exhausted tool failures.
 *
 * Both the harness decorator (`DeadLetterToolInvoker`) and the durable runtime
 * funnel (`Runtime.callTool`) record the same letter shape so a host can swap
 * in-memory vs disk-backed queues without coupling the two packages.
 */

/** One durably-recorded failed call, queued for human triage. */
export interface DeadLetter<TArgs = unknown> {
  /** Content-addressed from tool + args — repeated failures upsert `attempts`. */
  id: string;
  tool: string;
  args: TArgs;
  error: string;
  /** How many times this exact tool+args call has landed in the queue. */
  attempts: number;
  firstFailedAt: string;
  lastFailedAt: string;
  /** Durable call key in flight when the failure happened, if any. */
  key?: string;
}

/** Persistence seam — in-memory for tests; disk/DB in durable hosts. */
export interface DeadLetterQueue<TArgs = unknown> {
  push(letter: DeadLetter<TArgs>): void | Promise<void>;
  get(id: string): DeadLetter<TArgs> | undefined;
  list(): DeadLetter<TArgs>[];
  /** Remove a letter after resolve/replay. Returns true if one was removed. */
  remove(id: string): boolean;
}

/** Non-persistent queue — for tests and plain (non-durable) hosts. */
export class InMemoryDeadLetterQueue<TArgs = unknown> implements DeadLetterQueue<TArgs> {
  private readonly letters = new Map<string, DeadLetter<TArgs>>();

  push(letter: DeadLetter<TArgs>): void {
    this.letters.set(letter.id, letter);
  }
  get(id: string): DeadLetter<TArgs> | undefined {
    return this.letters.get(id);
  }
  list(): DeadLetter<TArgs>[] {
    return [...this.letters.values()];
  }
  remove(id: string): boolean {
    return this.letters.delete(id);
  }
}

/** FNV-1a — tiny deterministic string hash (zero-dep). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Deterministic id for a (tool, args) pair so repeated failures dedupe. */
export function deadLetterId(tool: string, args: unknown): string {
  return `dlq-${fnv1a(`${tool}:${JSON.stringify(args)}`)}`;
}
