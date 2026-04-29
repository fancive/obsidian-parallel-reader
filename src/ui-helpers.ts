'use strict';

import { Notice, setIcon } from 'obsidian';
import { translate } from './i18n';

export function addIconButton(parent: HTMLElement, icon: string, title: string, onClick: () => void | Promise<void>) {
  const button = parent.createEl('button', {
    cls: 'parallel-reader-icon-button',
    attr: { type: 'button', 'aria-label': title },
  });
  button.title = title;
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
      new Notice(
        translate(null, 'actionFailed', { label: title, error: err instanceof Error ? err.message : String(err) }),
      );
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
      new Notice(translate(null, 'actionFailed', { label, error: err instanceof Error ? err.message : String(err) }));
    });
  });
  return button;
}

export async function copyToClipboard(text: string, successMsg: string) {
  try {
    await navigator.clipboard.writeText(text);
    new Notice(successMsg);
  } catch (e: unknown) {
    new Notice(translate(null, 'copyFailed', { error: e instanceof Error ? e.message : String(e) }));
  }
}
