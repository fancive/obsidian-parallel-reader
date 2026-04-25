'use strict';

export function findLineForAnchor(content, anchor) {
  if (!anchor) return -1;
  const normalize = s => s.replace(/\s+/g, ' ').trim();
  const normalizeWithMap = s => {
    const chars = [];
    const map = [];
    let pendingWhitespace = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (/\s/.test(c)) {
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
  const tryAt = needle => {
    if (!needle) return -1;
    const idx = content.indexOf(needle);
    if (idx === -1) return -1;
    let line = 0;
    for (let i = 0; i < idx; i++) if (content[i] === '\n') line++;
    return line;
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
  let l = 0;
  for (let j = 0; j < originalIdx; j++) if (content[j] === '\n') l++;
  return l;
}
