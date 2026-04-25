'use strict';

import { Notice, setIcon } from 'obsidian';

export function addIconButton(parent, icon, title, onClick) {
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
  button.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await onClick();
    } catch (err) {
      console.error(err);
      new Notice(`${title} failed: ` + (err.message || err));
    }
  });
  return button;
}

export function addTextButton(parent, icon, label, onClick, cls?) {
  const button = parent.createEl('button', {
    cls: cls || 'parallel-reader-text-button',
    attr: { type: 'button' },
  });
  if (icon && typeof setIcon === 'function') setIcon(button, icon);
  button.createSpan({ text: label });
  button.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await onClick();
    } catch (err) {
      console.error(err);
      new Notice(`${label} failed: ` + (err.message || err));
    }
  });
  return button;
}

export async function copyToClipboard(text, successMsg) {
  try {
    await navigator.clipboard.writeText(text);
    new Notice(successMsg);
  } catch (e) {
    new Notice('Copy failed: ' + (e.message || e));
  }
}
