// Find where a cited chunk sits inside the original document text, so it can be highlighted.
//
// The stored chunk was cleaned during ingestion (hyphenated line breaks rejoined, whitespace
// collapsed), so it never matches the raw file or the PDF's text layer character for character.
// Comparing only letters, marks and digits, lower-cased, makes both sides line up again.

const ALNUM = /[\p{L}\p{M}\p{N}]/u; // letters, combining marks (e.g. Hindi vowel signs), digits

/** Letters/digits of `text`, lower-cased, plus each one's index in the original string. */
export function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ALNUM.test(ch)) {
      norm += ch.toLowerCase();
      map.push(i);
    }
  }
  return { norm, map };
}

/**
 * Start and end (exclusive) of `needle` inside `haystack`, in original-string positions.
 * Tries the whole chunk first; if that fails (e.g. a table extracted differently), falls back to
 * matching its beginning and end separately. Returns null when nothing matches.
 */
export function findRange(haystack: string, needle: string): [number, number] | null {
  const hay = normalizeWithMap(haystack);
  const nee = normalizeWithMap(needle).norm;
  if (!nee || !hay.norm) return null;

  const at = hay.norm.indexOf(nee);
  if (at >= 0) return [hay.map[at], hay.map[at + nee.length - 1] + 1];

  const probe = Math.min(60, Math.floor(nee.length / 2));
  if (probe < 12) return null;
  const start = hay.norm.indexOf(nee.slice(0, probe));
  if (start < 0) return null;
  const endProbe = hay.norm.indexOf(nee.slice(-probe), start);
  const endNorm = endProbe >= 0 ? endProbe + probe : Math.min(hay.norm.length, start + nee.length);
  return [hay.map[start], hay.map[endNorm - 1] + 1];
}
