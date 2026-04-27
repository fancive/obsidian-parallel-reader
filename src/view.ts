'use strict';

import { ItemView, MarkdownRenderer, Menu, Notice, TFile, type WorkspaceLeaf } from 'obsidian';
import { activeIndexAfterCardDelete, removeCardAt, updateCardAt } from './cards';
import { cardsToMarkdown, cardToMarkdown, cardToPlain } from './markdown';
import { CardEditModal } from './modal';
import { activeSectionLine, nextCardIndex } from './navigation';
import type { CardPatch, PluginHost, ResolvedCard } from './types';
import { addIconButton, addTextButton, copyToClipboard } from './ui-helpers';
import { ensureVaultFolder, normalizeVaultPath } from './vault';

export const VIEW_TYPE_PARALLEL = 'parallel-reader-view';

export class ParallelReaderView extends ItemView {
  plugin: PluginHost;
  sections: ResolvedCard[];
  sourceFile: TFile | null;
  cards: HTMLElement[];
  activeIdx: number;
  stale = false;
  loadingMessage = '';
  errorMessage = '';

  constructor(leaf: WorkspaceLeaf, plugin: PluginHost) {
    super(leaf);
    this.plugin = plugin;
    this.sections = [];
    this.sourceFile = null;
    this.cards = [];
    this.activeIdx = -1;
  }

  getViewType() {
    return VIEW_TYPE_PARALLEL;
  }
  getDisplayText() {
    return this.plugin.t('displayName');
  }
  getIcon() {
    return 'book-open';
  }

  onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('parallel-reader-container');
    container.setAttr('tabindex', '0');
    container.addEventListener('keydown', (e) => this.handleKeydown(e as KeyboardEvent));
    this.renderEmpty();
    this.focusSummaryPane();
    return Promise.resolve();
  }

  onClose() {
    return Promise.resolve();
  }

  renderEmpty() {
    this.sourceFile = null;
    this.sections = [];
    this.stale = false;
    this.loadingMessage = '';
    this.errorMessage = '';
    const container = this.containerEl.children[1];
    container.empty();
    const hint = container.createDiv({ cls: 'parallel-reader-empty' });
    hint.createEl('h3', { text: this.plugin.t('appTitle') });
    hint.createEl('p', { text: this.plugin.t('emptyOpenNote') });
    hint.createEl('code', { text: this.plugin.t('commandGenerate') });
  }

  focusSummaryPane() {
    const container = this.containerEl.children[1] as HTMLElement;
    if (!container || typeof container.focus !== 'function') return false;
    container.focus({ preventScroll: true });
    return true;
  }

  loadFor(file: TFile, sections: ResolvedCard[], stale: boolean) {
    this.sourceFile = file;
    this.sections = sections;
    this.stale = !!stale;
    this.loadingMessage = '';
    this.errorMessage = '';
    this.render();
  }

  renderLoading(file: TFile, message: string) {
    this.sourceFile = file;
    this.sections = [];
    this.stale = false;
    this.loadingMessage = message || this.plugin.t('loadingDefault');
    this.errorMessage = '';
    this.render();
  }

  renderStreamingPreview(file: TFile, text: string) {
    if (this.sourceFile?.path !== file.path) {
      this.sourceFile = file;
    }
    const container = this.containerEl.children[1];
    const existing = container.querySelector('.parallel-reader-streaming-preview');
    if (existing) {
      const pre = existing.querySelector('pre');
      if (pre) pre.textContent = text.slice(-2000);
      const counter = existing.querySelector('.parallel-reader-stream-counter');
      if (counter) counter.textContent = `${text.length} chars`;
      return;
    }
    container.empty();
    const header = container.createDiv({ cls: 'parallel-reader-header' });
    const headerRow = header.createDiv({ cls: 'parallel-reader-header-row' });
    headerRow.createEl('div', { text: file.basename, cls: 'parallel-reader-title' });
    const actions = headerRow.createDiv({ cls: 'parallel-reader-actions' });
    addIconButton(actions, 'square', this.plugin.t('actionCancel'), () => {
      this.plugin.cancelGenerationForFile(file);
    });

    const state = container.createDiv({
      cls: 'parallel-reader-state parallel-reader-loading parallel-reader-streaming-preview',
    });
    state.createDiv({ cls: 'parallel-reader-spinner' });
    const titleEl = state.createEl('div', { cls: 'parallel-reader-state-title' });
    titleEl.createSpan({ text: this.plugin.t('loadingGenerating') + ' ' });
    titleEl.createSpan({ cls: 'parallel-reader-stream-counter', text: `${text.length} chars` });
    const pre = state.createEl('pre', { cls: 'parallel-reader-stream-text' });
    pre.textContent = text.slice(-2000);
  }

  renderError(file: TFile, message: string) {
    this.sourceFile = file;
    this.sections = [];
    this.stale = false;
    this.loadingMessage = '';
    this.errorMessage = message || this.plugin.t('errorTitle');
    this.render();
  }

  renderEmptyWithHint(file: TFile) {
    this.sourceFile = file;
    this.sections = [];
    this.stale = false;
    this.loadingMessage = '';
    this.errorMessage = '';
    const container = this.containerEl.children[1];
    container.empty();
    const hint = container.createDiv({ cls: 'parallel-reader-empty' });
    hint.createEl('h3', { text: file.basename });
    hint.createEl('p', { text: this.plugin.t('emptyNoCache') });
    hint.createEl('code', { text: this.plugin.t('commandGenerate') });
    addTextButton(hint, null, this.plugin.t('actionGenerate'), () => {
      if (this.plugin.isGeneratingFile(file)) return;
      this.plugin.runForFile(file, false);
    });
  }

  render() {
    const container = this.containerEl.children[1];
    container.empty();

    this.renderHeader(container);
    if (this.stale) this.renderStaleBanner(container);
    if (this.loadingMessage) {
      this.renderLoadingState(container);
      return;
    }
    if (this.errorMessage) {
      this.renderErrorState(container);
      return;
    }
    this.renderCardList(container);
  }

  private renderHeader(container: Element) {
    const header = container.createDiv({ cls: 'parallel-reader-header' });
    const headerRow = header.createDiv({ cls: 'parallel-reader-header-row' });
    headerRow.createEl('div', { text: this.sourceFile?.basename || '', cls: 'parallel-reader-title' });
    const actions = headerRow.createDiv({ cls: 'parallel-reader-actions' });
    if (this.sourceFile) {
      if (this.plugin.isGeneratingFile(this.sourceFile)) {
        addIconButton(actions, 'square', this.plugin.t('actionCancel'), () => {
          this.plugin.cancelGenerationForFile(this.sourceFile);
        });
      } else {
        addIconButton(actions, 'refresh-cw', this.plugin.t('actionRegenerate'), () =>
          this.plugin.runForFile(this.sourceFile, true),
        );
      }
      addIconButton(actions, 'copy', this.plugin.t('actionCopyAll'), () => this.plugin.copyCurrentViewMarkdown());
      addIconButton(actions, 'download', this.plugin.t('actionExport'), () => this.exportToVault());
    }
  }

  private renderStaleBanner(container: Element) {
    const banner = container.createDiv({ cls: 'parallel-reader-stale-banner' });
    banner.createSpan({ text: this.plugin.t('staleBanner') });
    addTextButton(
      banner,
      'refresh-cw',
      this.plugin.t('actionRegenerate'),
      () => this.plugin.runForFile(this.sourceFile, true),
      'parallel-reader-stale-button',
    );
  }

  private renderLoadingState(container: Element) {
    const state = container.createDiv({ cls: 'parallel-reader-state parallel-reader-loading' });
    state.createDiv({ cls: 'parallel-reader-spinner' });
    state.createEl('div', { text: this.loadingMessage, cls: 'parallel-reader-state-title' });
    state.createEl('div', { text: this.plugin.t('loadingSubtitle'), cls: 'parallel-reader-state-subtitle' });
  }

  private renderErrorState(container: Element) {
    const state = container.createDiv({ cls: 'parallel-reader-state parallel-reader-error' });
    state.createEl('div', { text: this.plugin.t('errorTitle'), cls: 'parallel-reader-state-title' });
    state.createEl('div', {
      text: this.errorMessage,
      cls: 'parallel-reader-state-subtitle parallel-reader-selectable',
    });
    const actions = state.createDiv({ cls: 'parallel-reader-error-actions' });
    addTextButton(
      actions,
      'refresh-cw',
      this.plugin.t('actionRegenerate'),
      () => this.plugin.runForFile(this.sourceFile, true),
      'parallel-reader-text-button',
    );
    addTextButton(
      actions,
      'copy',
      this.plugin.t('actionCopyError'),
      () => copyToClipboard(this.errorMessage, this.plugin.t('actionCopyError')),
      'parallel-reader-text-button',
    );
  }

  private renderCardList(container: Element) {
    const list = container.createDiv({ cls: 'parallel-reader-cards' });
    this.cards = [];
    const sourcePath = this.sourceFile?.path || '';
    this.sections.forEach((s, i) => {
      this.cards.push(this.renderCard(list, s, i, sourcePath));
    });
    if (this.activeIdx >= 0 && this.cards[this.activeIdx]) {
      this.cards[this.activeIdx].addClass('is-active');
    }
  }

  private renderCard(list: Element, s: ResolvedCard, i: number, sourcePath: string): HTMLElement {
    const card = list.createDiv({ cls: 'parallel-reader-card' });
    card.dataset.idx = String(i);
    if (s.startLine < 0) card.addClass('parallel-reader-card-unanchored');

    const title = card.createEl('div', { cls: 'parallel-reader-card-title' });
    title.createSpan({ text: s.title });
    if (s.startLine < 0) {
      title.createEl('span', { text: ' ⚠', cls: 'parallel-reader-warn', title: this.plugin.t('anchorMismatch') });
    }

    if (s.gist) {
      const gistEl = card.createEl('div', { cls: 'parallel-reader-gist' });
      MarkdownRenderer.render(this.app, s.gist, gistEl, sourcePath, this).catch(() => {
        gistEl.setText(s.gist);
      });
    }

    const bs = s.bullets || [];
    if (bs.length > 0) {
      const bulletsEl = card.createEl('div', { cls: 'parallel-reader-bullets-md' });
      const md = bs.map((b) => `- ${b}`).join('\n');
      MarkdownRenderer.render(this.app, md, bulletsEl, sourcePath, this).catch(() => {
        bulletsEl.setText(md);
      });
    } else if (!s.gist) {
      card.createEl('div', { cls: 'parallel-reader-empty-li', text: this.plugin.t('emptyCard') });
    }

    card.addEventListener('click', (e) => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === 'A') return;
      if (s.startLine >= 0) void this.plugin.scrollEditorToLine(s.startLine, this.sourceFile);
    });

    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showCardContextMenu(e, s, i);
    });

    return card;
  }

  private showCardContextMenu(e: MouseEvent, s: ResolvedCard, i: number) {
    const menu = new Menu();
    menu.addItem((it) =>
      it
        .setTitle(this.plugin.t('menuCopyMarkdown'))
        .setIcon('copy')
        .onClick(() => copyToClipboard(cardToMarkdown(s), this.plugin.t('copiedMarkdown'))),
    );
    menu.addItem((it) =>
      it
        .setTitle(this.plugin.t('menuCopyPlain'))
        .setIcon('clipboard-copy')
        .onClick(() => copyToClipboard(cardToPlain(s), this.plugin.t('copiedPlain'))),
    );
    if (s.anchor) {
      menu.addItem((it) =>
        it
          .setTitle(this.plugin.t('menuCopyAnchor'))
          .setIcon('quote-glyph')
          .onClick(() => copyToClipboard(s.anchor, this.plugin.t('copiedAnchor'))),
      );
    }
    menu.addSeparator();
    if (s.startLine >= 0) {
      menu.addItem((it) =>
        it
          .setTitle(this.plugin.t('menuJumpSource'))
          .setIcon('arrow-right')
          .onClick(() => this.plugin.scrollEditorToLine(s.startLine, this.sourceFile)),
      );
    }
    menu.addSeparator();
    menu.addItem((it) =>
      it
        .setTitle(this.plugin.t('menuEditCard'))
        .setIcon('pencil')
        .onClick(() => this.openEditCardModal(i)),
    );
    menu.addItem((it) =>
      it
        .setTitle(this.plugin.t('menuDeleteCard'))
        .setIcon('trash')
        .onClick(() => this.deleteCard(i)),
    );
    menu.showAtMouseEvent(e);
  }

  setActiveSection(idx: number) {
    if (idx === this.activeIdx) return;
    if (this.activeIdx >= 0 && this.cards[this.activeIdx]) {
      this.cards[this.activeIdx].removeClass('is-active');
    }
    this.activeIdx = idx;
    if (idx >= 0 && this.cards[idx]) {
      this.cards[idx].addClass('is-active');
      this.cards[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  moveActiveSection(delta: number) {
    const nextIdx = nextCardIndex(this.activeIdx, this.sections.length, delta);
    this.setActiveSection(nextIdx);
    this.focusSummaryPane();
    return nextIdx;
  }

  jumpToActiveSection() {
    const line = activeSectionLine(this.sections, this.activeIdx);
    if (line < 0 || !this.sourceFile) return -1;
    void this.plugin.scrollEditorToLine(line, this.sourceFile);
    return line;
  }

  handleKeydown(e: KeyboardEvent) {
    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      this.moveActiveSection(-1);
      return;
    }
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      this.moveActiveSection(1);
      return;
    }
    if (!e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.key === 'Enter') {
      const line = this.jumpToActiveSection();
      if (line >= 0) e.preventDefault();
    }
  }

  async deleteCard(index: number) {
    if (!this.sourceFile) return false;
    const nextSections = removeCardAt(this.sections, index);
    if (nextSections.length === this.sections.length) return false;
    const previousLength = this.sections.length;
    this.sections = nextSections;
    this.activeIdx = activeIndexAfterCardDelete(index, previousLength, this.activeIdx);
    await this.plugin.cacheReplaceCards(this.sourceFile.path, nextSections);
    this.render();
    new Notice(this.plugin.t('cardDeleted'));
    return true;
  }

  openEditCardModal(index: number) {
    if (!this.sourceFile || !this.sections[index]) return false;
    new CardEditModal(this.app, this.plugin, this.sections[index], async (patch) => {
      await this.updateCard(index, patch);
    }).open();
    return true;
  }

  async updateCard(index: number, patch: CardPatch) {
    if (!this.sourceFile) return false;
    const nextSections = updateCardAt(this.sections, index, patch);
    if (nextSections.length !== this.sections.length) return false;
    this.sections = nextSections;
    await this.plugin.cacheReplaceCards(this.sourceFile.path, nextSections);
    this.render();
    new Notice(this.plugin.t('cardSaved'));
    return true;
  }

  async exportToVault() {
    if (!this.sourceFile) return;
    const folder = normalizeVaultPath(this.plugin.settings.exportFolder);
    const name = `${this.sourceFile.basename} - ${this.plugin.t('displayName')}.md`;
    const targetPath = `${folder}/${name}`;

    const markdown = [
      '---',
      `source: [[${this.sourceFile.basename}]]`,
      `generated: ${new Date().toISOString().slice(0, 10)}`,
      'tool: parallel-reader',
      '---',
      '',
      cardsToMarkdown(`${this.sourceFile.basename} · ${this.plugin.t('displayName')}`, this.sections),
      '',
    ].join('\n');

    const app = this.plugin.app;
    await ensureVaultFolder(app, folder);

    const existing = app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
      await app.vault.modify(existing, markdown);
    } else {
      await app.vault.create(targetPath, markdown);
    }
    new Notice(this.plugin.t('exported', { path: targetPath }));
  }
}
