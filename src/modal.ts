'use strict';

import { Modal } from 'obsidian';
import type { CardPatch, PluginHost, ResolvedCard } from './types';
import { addTextButton } from './ui-helpers';

export class CardEditModal extends Modal {
  plugin: PluginHost;
  card: ResolvedCard;
  onSave: (patch: CardPatch) => void | Promise<void>;

  constructor(app, plugin: PluginHost, card: ResolvedCard, onSave: (patch: CardPatch) => void | Promise<void>) {
    super(app);
    this.plugin = plugin;
    this.card = card || ({} as ResolvedCard);
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
            .map((line) => line.trim())
            .filter(Boolean),
        });
        this.close();
      },
      'parallel-reader-text-button',
    );
  }

  createLabeledInput(parent, label: string, value: string) {
    const wrapper = parent.createDiv({ cls: 'parallel-reader-modal-field' });
    wrapper.createEl('label', { text: label });
    const input = wrapper.createEl('input', { attr: { type: 'text' } });
    input.value = value;
    return input;
  }

  createLabeledTextarea(parent, label: string, value: string, rows: number) {
    const wrapper = parent.createDiv({ cls: 'parallel-reader-modal-field' });
    wrapper.createEl('label', { text: label });
    const textarea = wrapper.createEl('textarea');
    textarea.rows = rows;
    textarea.value = value;
    return textarea;
  }
}
