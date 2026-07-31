/**
 * CLI stdin approver for mutating FS tools (and other gated tools).
 */

import * as readline from 'node:readline';

import type { ApprovalDecision, ApprovalRequest, Approver } from '@agent/contracts';

/** Default stdin wait — avoid hanging forever if stdin is closed / non-interactive. */
export const DEFAULT_STDIN_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export function createStdinApprover(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
  opts?: { timeoutMs?: number },
): Approver {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_STDIN_APPROVAL_TIMEOUT_MS;
  return {
    async approve(req: ApprovalRequest): Promise<ApprovalDecision> {
      const preview = JSON.stringify(req.args, null, 2).slice(0, 1200);
      output.write(
        `\n⚠ approve tool "${req.tool}" (callId=${req.callId})?\n${preview}\n[y]es / [n]o: `,
      );
      const answer = (await readLine(input, timeoutMs)).trim().toLowerCase();
      if (answer === '__timeout__') {
        output.write(`\n(approval timed out after ${timeoutMs}ms — denying)\n`);
        return {
          approved: false,
          reason: `approval timed out after ${timeoutMs}ms`,
          decidedAt: Date.now(),
        };
      }
      const approved = answer === 'y' || answer === 'yes';
      return {
        approved,
        reason: approved ? 'stdin yes' : 'stdin no',
        decidedAt: Date.now(),
      };
    },
  };
}

function readLine(input: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  const rl = readline.createInterface({ input, output: undefined, terminal: false });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (line: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolve(line);
    };
    const timer = setTimeout(() => finish('__timeout__'), timeoutMs);
    rl.once('line', (line) => finish(line));
    rl.once('close', () => finish(''));
  });
}
