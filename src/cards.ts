'use strict';

export function removeCardAt(cards, index) {
  const next = Array.isArray(cards) ? cards.slice() : [];
  if (!Number.isInteger(index) || index < 0 || index >= next.length) return next;
  next.splice(index, 1);
  return next;
}

export function activeIndexAfterCardDelete(deleteIndex, previousLength, activeIdx) {
  if (!Number.isInteger(deleteIndex) || !Number.isInteger(previousLength) || previousLength <= 0) return activeIdx;
  if (!Number.isInteger(activeIdx) || activeIdx < 0) return activeIdx;
  if (deleteIndex < 0 || deleteIndex >= previousLength) return activeIdx;
  const nextLength = previousLength - 1;
  if (nextLength <= 0) return -1;
  if (deleteIndex < activeIdx) return Math.max(0, activeIdx - 1);
  if (deleteIndex === activeIdx) return Math.min(activeIdx, nextLength - 1);
  return activeIdx;
}

export function updateCardAt(cards, index, patch) {
  const next = Array.isArray(cards) ? cards.slice() : [];
  if (!Number.isInteger(index) || index < 0 || index >= next.length) return next;
  next[index] = Object.assign({}, next[index], patch || {});
  return next;
}
