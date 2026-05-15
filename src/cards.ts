'use strict';

import { buildLineOffsets, findLineForAnchor } from './anchor';
import type { CardPatch, RawCard, ResolvedCard } from './types';

export function removeCardAt<T extends RawCard>(cards: T[], index: number): T[] {
  const next = Array.isArray(cards) ? cards.slice() : [];
  if (!Number.isInteger(index) || index < 0 || index >= next.length) return next;
  next.splice(index, 1);
  return next;
}

export function activeIndexAfterCardDelete(deleteIndex: number, previousLength: number, activeIdx: number): number {
  if (!Number.isInteger(deleteIndex) || !Number.isInteger(previousLength) || previousLength <= 0) return activeIdx;
  if (!Number.isInteger(activeIdx) || activeIdx < 0) return activeIdx;
  if (deleteIndex < 0 || deleteIndex >= previousLength) return activeIdx;
  const nextLength = previousLength - 1;
  if (nextLength <= 0) return -1;
  if (deleteIndex < activeIdx) return Math.max(0, activeIdx - 1);
  if (deleteIndex === activeIdx) return Math.min(activeIdx, nextLength - 1);
  return activeIdx;
}

export function updateCardAt<T extends RawCard>(cards: T[], index: number, patch: CardPatch): T[] {
  const next = Array.isArray(cards) ? cards.slice() : [];
  if (!Number.isInteger(index) || index < 0 || index >= next.length) return next;
  next[index] = Object.assign({}, next[index], patch || {});
  return next;
}

export function resolveCardAnchors(content: string, rawCards: RawCard[]): ResolvedCard[] {
  // Build the line-offset index once and reuse it for every card instead of
  // rescanning the whole document per anchor.
  const lineOffsets = buildLineOffsets(content);
  const resolved: ResolvedCard[] = (rawCards || []).map((c: RawCard) => ({
    title: c.title,
    level: 2,
    anchor: c.anchor,
    gist: c.gist,
    startLine: findLineForAnchor(content, c.anchor, lineOffsets),
    bullets: c.bullets || [],
  }));
  resolved.sort((a, b) => {
    if (a.startLine < 0 && b.startLine < 0) return 0;
    if (a.startLine < 0) return 1;
    if (b.startLine < 0) return -1;
    return a.startLine - b.startLine;
  });
  return resolved;
}
