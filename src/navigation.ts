'use strict';

import type { ResolvedCard } from './types';

export function nextCardIndex(activeIdx: number, cardCount: number, delta: number): number {
  if (!Number.isFinite(cardCount) || cardCount <= 0) return -1;
  const count = Math.floor(cardCount);
  const direction = delta < 0 ? -1 : 1;
  if (activeIdx < 0 || activeIdx >= count) return direction < 0 ? count - 1 : 0;
  return Math.min(count - 1, Math.max(0, activeIdx + direction));
}

export function activeSectionLine(sections: ResolvedCard[], activeIdx: number): number {
  if (!Array.isArray(sections) || activeIdx < 0 || activeIdx >= sections.length) return -1;
  const line = Number(sections[activeIdx]?.startLine);
  return Number.isFinite(line) && line >= 0 ? line : -1;
}
