'use strict';

import { type App, Modal } from 'obsidian';
import type { CardPatch, PluginHost, ResolvedCard } from './types';
import { addTextButton } from './ui-helpers';

function confirmAction(
  app: App,
  title: string,
  message: string,
  cancelText: string,
  confirmText: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const modal = new Modal(app);
    modal.titleEl.setText(title);
    modal.contentEl.createEl('p', { text: message });
    const btnRow = modal.contentEl.createDiv({ cls: 'modal-button-container' });
    btnRow.createEl('button', { text: cancelText }).addEventListener('click', () => {
      modal.close();
      settle(false);
    });
    btnRow.createEl('button', { text: confirmText, cls: 'mod-cta' }).addEventListener('click', () => {
      modal.close();
      settle(true);
    });
    modal.onClose = () => settle(false);
    modal.open();
  });
}

export function confirmRegenerateEditedCards(
  app: App,
  title: string,
  message: string,
  cancelText: string,
  confirmText: string,
): Promise<boolean> {
  return confirmAction(app, title, message, cancelText, confirmText);
}

export function confirmExportOverwrite(
  app: App,
  title: string,
  message: string,
  cancelText: string,
  confirmText: string,
): Promise<boolean> {
  return confirmAction(app, title, message, cancelText, confirmText);
}

export class CardEditModal extends Modal {
  plugin: PluginHost;
  card: ResolvedCard;
  onSave: (patch: CardPatch) => void | Promise<void>;

  constructor(app: App, plugin: PluginHost, card: ResolvedCard, onSave: (patch: CardPatch) => void | Promise<void>) {
    super(app);
    this.plugin = plugin;
    this.card = card;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: this.plugin.t('editCardTitle') });

    const titleInput = this.createLabeledInput(contentEl, this.plugin.t('editCardTitleField'), this.card.title || '');
    const gistInput = this.createLabeledTextarea(
      contentEl,
      this.plugin.t('editCardGistField'),
      this.card.gist || '',
      3,
    );
    const bulletsInput = this.createLabeledTextarea(
      contentEl,
      this.plugin.t('editCardBulletsField'),
      (this.card.bullets || []).join('\n'),
      8,
    );

    const actions = contentEl.createDiv({ cls: 'parallel-reader-modal-actions' });
    addTextButton(actions, null, this.plugin.t('editCardCancel'), () => this.close(), 'parallel-reader-text-button');
    addTextButton(
      actions,
      null,
      this.plugin.t('editCardSave'),
      async () => {
        await this.onSave({
          title: titleInput.value.trim() || this.card.title || '',
          gist: gistInput.value.trim(),
          bullets: bulletsInput.value
            .split(/\r?\n/)
            .map((line: string) => line.trim())
            .filter(Boolean),
        });
        this.close();
      },
      'parallel-reader-text-button',
    );
  }

  createLabeledInput(parent: HTMLElement, label: string, value: string) {
    const wrapper = parent.createDiv({ cls: 'parallel-reader-modal-field' });
    wrapper.createEl('label', { text: label });
    const input = wrapper.createEl('input', { attr: { type: 'text' } });
    input.value = value;
    return input;
  }

  createLabeledTextarea(parent: HTMLElement, label: string, value: string, rows: number) {
    const wrapper = parent.createDiv({ cls: 'parallel-reader-modal-field' });
    wrapper.createEl('label', { text: label });
    const textarea = wrapper.createEl('textarea');
    textarea.rows = rows;
    textarea.value = value;
    return textarea;
  }
}
