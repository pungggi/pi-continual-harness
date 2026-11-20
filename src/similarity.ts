// Shared text-similarity seam — the ONE token-overlap implementation behind
// both the dedupe proposer (pair detection) and the recreate detector
// (tombstone matching, tombstones.ts). Extracted from proposer.ts (0.24.0)
// so store-adjacent modules can match near-duplicate content without a
// store → proposer import cycle (proposer imports the store's mergeSupport).
// proposer.ts re-exports these for API stability; companions and tests keep
// importing from either side.

/** Default token-overlap threshold in (0,1]: pairs at/above it count as the
 *  same correction. The historical dedupe value; the recreate detector
 *  shares it so "same item" means the same thing everywhere a correction is
 *  compared against stored text. */
export const DEDUPE_THRESHOLD = 0.6;

/** Tokenize for overlap comparison: lowercase alnum tokens. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Jaccard token overlap in [0,1]. 0 if either side has no tokens. */
export function tokenOverlap(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}
