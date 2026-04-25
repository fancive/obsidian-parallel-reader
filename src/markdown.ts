'use strict';

export function cardToMarkdown(card) {
  const parts = [`## ${card.title}`];
  if (card.anchor) {
    const q = card.anchor.replace(/\s+/g, ' ').trim();
    parts.push(`> ${q}`);
  }
  if (card.gist) parts.push(card.gist);
  if (card.bullets && card.bullets.length > 0) {
    parts.push(card.bullets.map(b => `- ${b}`).join('\n'));
  }
  return parts.join('\n\n');
}

export function cardToPlain(card) {
  return [
    card.title,
    card.gist || '',
    ...(card.bullets || []).map(b => '• ' + b),
  ].filter(Boolean).join('\n');
}

export function cardsToMarkdown(title, cards) {
  const parts = [`# ${title || '对照笔记'}`];
  for (const card of cards || []) {
    parts.push(cardToMarkdown(card));
  }
  return parts.join('\n\n');
}
