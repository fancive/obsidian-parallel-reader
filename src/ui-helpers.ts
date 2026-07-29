'use strict';

import { Notice, setIcon, setTooltip } from 'obsidian';

export function addIconButton(parent: HTMLElement, icon: string, title: string, onClick: () => void | Promise<void>) {
  const button = parent.createEl('button', {
    cls: 'parallel-reader-icon-button',
    attr: { type: 'button', 'aria-label': title },
  });
  // Use Obsidian's own tooltip manager instead of the native `title` attribute:
  // the two used to stack (Obsidian's tooltip on hover, then the OS tooltip a
  // moment later), showing the same text twice.
  if (typeof setTooltip === 'function') {
    setTooltip(button, title, { placement: 'bottom' });
  }
  if (typeof setIcon === 'function') {
    setIcon(button, icon);
  } else {
    button.textContent = title;
  }
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    Promise.resolve(onClick()).catch((err: unknown) => {
      console.error(err);
      new Notice(`${title} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  return button;
}

export function addTextButton(
  parent: HTMLElement,
  icon: string | null,
  label: string,
  onClick: () => void | Promise<void>,
  cls?: string,
) {
  const button = parent.createEl('button', {
    cls: cls || 'parallel-reader-text-button',
    attr: { type: 'button' },
  });
  if (icon && typeof setIcon === 'function') setIcon(button, icon);
  button.createSpan({ text: label });
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    Promise.resolve(onClick()).catch((err: unknown) => {
      console.error(err);
      new Notice(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  return button;
}

export async function copyToClipboard(text: string, successMsg: string) {
  try {
    await navigator.clipboard.writeText(text);
    new Notice(successMsg);
  } catch (e: unknown) {
    new Notice(`Copy failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
