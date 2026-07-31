/**
 * Extract top descriptive comments from a source file.
 *
 * Reads the beginning of a file and collects consecutive comment lines
 * (block comments / JSDoc, line comments, hash comments, shebang)
 * until it hits actual code.  Useful for getting a summary of what a
 * file does without loading the entire file into context.
 */

import { readFileSync, statSync } from 'node:fs';

import type { ToolDef } from 'durable-agent-runtime';

import type { Workspace } from '../workspace.js';

export interface ExtractTopCommentsResult {
  /** The file path (workspace-relative). */
  path: string;
  /** Total lines in the file. */
  totalLines: number;
  /** The extracted descriptive comments (may be empty). */
  comments: string;
  /** Number of comment lines consumed at the top of the file. */
  consumedLines: number;
}

export function createExtractTopCommentsTool(
  workspace: Workspace,
): ToolDef<{ filePath: string }, ExtractTopCommentsResult> {
  return {
    name: 'extract_top_comments',
    description:
      'Extract the descriptive block-comments / JSDoc / line-comments / hash-comments ' +
      'at the very top of a source file. Stops as soon as it encounters a non-comment, ' +
      'non-blank line. Use this tool to quickly understand what a file does before ' +
      'deciding whether to load the full file contents.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Workspace-relative path to the source file.',
        },
      },
      required: ['filePath'],
    },
    run: ({ filePath }) => {
      const abs = workspace.resolve(filePath);
      const st = statSync(abs);
      if (!st.isFile()) throw new Error(`extract_top_comments: not a file: ${filePath}`);

      const raw = readFileSync(abs, 'utf8');
      const allLines = raw.split(/\r?\n/);
      const totalLines = allLines.length;

      const commentLines: string[] = [];
      let inBlock = false;
      let consumed = 0;

      for (const line of allLines) {
        const trimmed = line.trim();

        // Handle multi-line block comments
        if (inBlock) {
          commentLines.push(line);
          consumed += 1;
          if (trimmed.includes('*/')) {
            inBlock = false;
          }
          continue;
        }

        // Blank line between comment sections — still part of the header
        if (trimmed === '') {
          // Only include blank lines after we've already collected some comments
          if (commentLines.length > 0) {
            commentLines.push(line);
            consumed += 1;
          } else {
            // Leading blank lines before any comments are skipped
            consumed += 1;
          }
          continue;
        }

        // Shebang
        if (trimmed.startsWith('#!')) {
          commentLines.push(line);
          consumed += 1;
          continue;
        }

        // Block comment start: /** ... */ or /* ... */
        if (trimmed.startsWith('/**') || trimmed.startsWith('/*')) {
          commentLines.push(line);
          consumed += 1;
          if (!trimmed.endsWith('*/')) {
            inBlock = true;
          }
          continue;
        }

        // Closing */ on its own line (continuation without matching start — rare)
        if (trimmed.startsWith('*/')) {
          commentLines.push(line);
          consumed += 1;
          continue;
        }

        // Line comment (//) or hash comment (#)
        if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
          commentLines.push(line);
          consumed += 1;
          continue;
        }

        // Anything else: this is code — stop here
        break;
      }

      return {
        path: filePath,
        totalLines,
        comments: commentLines.join('\n'),
        consumedLines: consumed,
      };
    },
  };
}
