/**
 * Load KEY=VALUE pairs from a gitignored .env into process.env (does not override
 * variables already set in the shell).
 */

import { existsSync, readFileSync } from 'node:fs';

export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && env[key] === undefined) env[key] = value;
  }
}
