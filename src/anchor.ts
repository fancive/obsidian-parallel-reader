'use strict';

// Precompute the byte offset where each line starts (offsets[k] = start of
// line k). Built once per document so callers resolving many anchors over the
// same content avoid an O(n) newline rescan per anchor.
export function buildLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) offsets.push(i + 1);
  }
  return offsets;
}

// Largest line index whose start offset is <= charOffset, i.e. the 0-based
// line containing charOffset. Equivalent to counting '\n' before charOffset
// but O(log n) instead of O(n).
function offsetToLine(offsets: number[], charOffset: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= charOffset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function findLineForAnchor(content: string, anchor: string, lineOffsets?: number[]): number {
  if (!anchor) return -1;
  const offsets = lineOffsets ?? buildLineOffsets(content);
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const normalizeWithMap = (s: string) => {
    const chars: string[] = [];
    const map: number[] = [];
    let pendingWhitespace = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const code = s.charCodeAt(i);
      // ASCII whitespace fast path; defer to /\s/ only for rare non-ASCII
      // code points so the exact RegExp semantics are preserved.
      const isWhitespace =
        code === 32 ||
        code === 9 ||
        code === 10 ||
        code === 13 ||
        code === 12 ||
        code === 11 ||
        (code > 127 && /\s/.test(c));
      if (isWhitespace) {
        pendingWhitespace = chars.length > 0;
        continue;
      }
      if (pendingWhitespace) {
        chars.push(' ');
        map.push(i);
        pendingWhitespace = false;
      }
      chars.push(c);
      map.push(i);
    }
    return { text: chars.join(''), map };
  };
  const tryAt = (needle: string) => {
    if (!needle) return -1;
    const idx = content.indexOf(needle);
    if (idx === -1) return -1;
    return offsetToLine(offsets, idx);
  };

  let line = tryAt(anchor);
  if (line >= 0) return line;

  line = tryAt(anchor.trim());
  if (line >= 0) return line;

  for (const len of [60, 40, 25, 15]) {
    const prefix = anchor.trim().slice(0, len);
    line = tryAt(prefix);
    if (line >= 0) return line;
  }

  const normDoc = normalizeWithMap(content);
  const normAnchor = normalize(anchor).slice(0, 30);
  if (!normAnchor) return -1;
  const normIdx = normDoc.text.indexOf(normAnchor);
  if (normIdx === -1) return -1;
  const originalIdx = normDoc.map[normIdx];
  if (originalIdx == null) return -1;
  return offsetToLine(offsets, originalIdx);
}
