/**
 * Shared zero-dependency utilities used by both the harness and the runtime.
 *
 * These are small, pure functions that would otherwise be duplicated.  They are
 * deliberately NOT re-exported from the contracts index so callers opt in
 * explicitly (the contracts package is primarily for types).
 */

// ── JSON extraction ──────────────────────────────────────────────────

/** Extract the first balanced `{...}` object from arbitrary text (string-aware). */
export function extractJsonObject(text: string): string | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return undefined;
}

// ── CJK detection ───────────────────────────────────────────────────

/**
 * Returns true for full CJK / full-width Unicode codepoints.
 * Shared by the harness tokenizer and runtime memory-search scorer so the two
 * stay in sync without duplicating the range table.
 */
export function isCjkCodepoint(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x2eff) ||   // CJK radicals
    (cp >= 0x3000 && cp <= 0x303f) ||   // CJK symbols & punctuation
    (cp >= 0x3040 && cp <= 0x30ff) ||   // Hiragana + Katakana
    (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK Unified Ideographs
    (cp >= 0xac00 && cp <= 0xd7af) ||   // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK compatibility ideographs
    (cp >= 0xff00 && cp <= 0xffef) ||   // Half/full-width forms
    (cp >= 0x20000 && cp <= 0x2a6df)    // CJK Ext B (astral plane)
  );
}
