/**
 * CLI stdin approver for mutating FS tools (and other gated tools).
 */

import * as readline from 'node:readline';

import type { ApprovalDecision, ApprovalRequest, Approver } from '@agent/contracts';

export function createStdinApprover(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stderr): Approver {
  return {
    async approve(req: ApprovalRequest): Promise<ApprovalDecision> {
      const preview = JSON.stringify(req.args, null, 2).slice(0, 1200);
      output.write(
        `\n⚠ approve tool "${req.tool}" (callId=${req.callId})?\n${preview}\n[y]es / [n]o: `,
      );
      const answer = (await readLine(input)).trim().toLowerCase();
      const approved = answer === 'y' || answer === 'yes';
      return {
        approved,
        reason: approved ? 'stdin yes' : 'stdin no',
        decidedAt: Date.now(),
      };
    },
  };
}

function readLine(input: NodeJS.ReadableStream): Promise<string> {
  const rl = readline.createInterface({ input, output: undefined, terminal: false });
  return new Promise((resolve) => {
    rl.once('line', (line) => {
      rl.close();
      resolve(line);
    });
  });
}
