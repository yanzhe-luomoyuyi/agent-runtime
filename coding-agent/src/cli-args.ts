/** CLI argv helpers (no side effects — safe to import from tests). */

export function parseArgs(argv: string[]): { workspace?: string; args: string[] } {
  const args: string[] = [];
  let workspace: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--workspace' || a === '-W') {
      const next = argv[++i];
      if (!next) throw new Error(`${a} requires a path`);
      workspace = next;
      continue;
    }
    if (a.startsWith('--workspace=')) {
      workspace = a.slice('--workspace='.length);
      if (!workspace) throw new Error('--workspace= requires a path');
      continue;
    }
    args.push(a);
  }
  return { workspace, args };
}
