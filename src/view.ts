'use strict';

import { ItemView, MarkdownRenderer, Menu, Notice, setIcon, TFile, type WorkspaceLeaf } from 'obsidian';
import { activeIndexAfterCardDelete, removeCardAt, updateCardAt } from './cards';
import { cardsToMarkdown, cardToMarkdown, cardToPlain } from './markdown';
import { CardEditModal, confirmExportOverwrite } from './modal';
import { activeSectionLine, nextCardIndex } from './navigation';
import type { CardPatch, PluginHost, ResolvedCard } from './types';
import { addIconButton, addTextButton, copyToClipboard, type Translator } from './ui-helpers';
import { ensureVaultFolder, normalizeVaultPath } from './vault';

export const VIEW_TYPE_PARALLEL = 'parallel-reader-view';

/**
 * How long (ms) to ignore scroll-sync reassignment after a card click drives an
 * editor scroll. `editor.scrollIntoView(..., true)` centers the target line, so
 * the scroll handler's near-top probe (see `visibleTopProbeY` in scroll.ts) can
 * land inside the PRECEDING card's line range and steal the highlight straight
 * back from the card the user just clicked. A short window absorbs that one
 * scroll event. A timestamp deadline is used rather than a boolean latch: if the
 * expected scroll event never fires, a boolean would leave the view permanently
 * desynced, whereas a deadline self-expires and can never wedge sync forever.
 */
const SCROLL_SYNC_CLICK_SUPPRESS_MS = 400;

export class ParallelReaderView extends ItemView {
  plugin: PluginHost;
  sections: ResolvedCard[];
  sourceFile: TFile | null;
  cards: HTMLElement[];
  activeIdx: number;
  stale = false;
  loadingMessage = '';
  errorMessage = '';
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private keydownTarget: Element | null = null;
  /** Date.now()-based deadline; see SCROLL_SYNC_CLICK_SUPPRESS_MS. */
  private scrollSyncSuppressedUntil = 0;
  /**
   * Bound translator passed into `ui-helpers.ts` (addIconButton/addTextButton/copyToClipboard)
   * so their failure toasts localize via `actionFailed`/`copyFailed` instead of hardcoding
   * English. Declared as an arrow field (not `this.plugin.t.bind(this.plugin)`) so it closes
   * over `this` lazily -- field initializers run before the constructor body assigns
   * `this.plugin`, and this body isn't evaluated until the helper actually calls it.
   */
  private tr: Translator = (key, vars) => this.plugin.t(key, vars);

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
    this.keydownHandler = (e) => this.handleKeydown(e);
    this.keydownTarget = container;
    container.addEventListener('keydown', this.keydownHandler as EventListener);
    this.renderEmpty();
    this.focusSummaryPane();
    return Promise.resolve();
  }

  onClose() {
    if (this.keydownHandler && this.keydownTarget) {
      this.keydownTarget.removeEventListener('keydown', this.keydownHandler as EventListener);
    }
    this.keydownHandler = null;
    this.keydownTarget = null;
    return Promise.resolve();
  }

  /**
   * Bookkeeping that must happen every time `sections` is replaced — including
   * with an empty array for a loading/error/empty state. `cards` is always
   * cleared, since the DOM elements it references are about to be rebuilt or
   * removed by the caller's own render pass. `activeIdx` only resets when the
   * file actually changed: this keeps scroll-sync position intact across an
   * ordinary refresh/regenerate of the SAME note, while guaranteeing a stale
   * highlight from the PREVIOUS note can never survive a file switch.
   *
   * The click-suppression deadline resets on the same condition, and for the same
   * reason. It belongs to a click on a card of the note that was showing; a note opened
   * inside that 400ms window would otherwise inherit it, and its first
   * `syncActiveFromEditor` pass would return early — leaving the new note with no
   * highlight at all until the user physically scrolled. A same-file refresh must NOT
   * reset it: surviving the render that follows a click is exactly its job.
   */
  private beginSectionsReplace(file: TFile | null, sections: ResolvedCard[]) {
    const switchedFile = (this.sourceFile?.path ?? null) !== (file?.path ?? null);
    this.sourceFile = file;
    this.sections = sections;
    this.cards = [];
    if (switchedFile) {
      this.activeIdx = -1;
      this.scrollSyncSuppressedUntil = 0;
    }
  }

  renderEmpty() {
    this.beginSectionsReplace(null, []);
    this.stale = false;
    this.loadingMessage = '';
    this.errorMessage = '';
    const container = this.containerEl.children[1];
    container.empty();
    const hint = container.createDiv({ cls: 'parallel-reader-empty' });
    hint.createEl('h3', { text: this.plugin.t('appTitle') });
    hint.createEl('p', { text: this.plugin.t('emptyOpenNote') });
    hint.createEl('code', { text: this.plugin.t('commandGenerate') });
    this.appendSetupNudge(hint);
  }

  /**
   * When no credential is configured, append a "set up your AI provider" call-to-action
   * so a first-run user does not hit a dead-end (Generate → immediate API-key error).
   */
  private appendSetupNudge(parent: HTMLElement): boolean {
    if (this.plugin.isCredentialConfigured()) return false;
    parent.createEl('p', { cls: 'parallel-reader-setup-hint', text: this.plugin.t('emptyNeedsSetup') });
    addTextButton(parent, 'settings', this.plugin.t('actionSetupProvider'), () => this.plugin.openSettings(), this.tr);
    return true;
  }

  focusSummaryPane() {
    const container = this.containerEl.children[1] as HTMLElement;
    if (!container || typeof container.focus !== 'function') return false;
    container.focus({ preventScroll: true });
    return true;
  }

  loadFor(file: TFile, sections: ResolvedCard[], stale: boolean) {
    this.beginSectionsReplace(file, sections);
    this.stale = !!stale;
    this.loadingMessage = '';
    this.errorMessage = '';
    this.render();
  }

  renderLoading(file: TFile, message: string) {
    this.beginSectionsReplace(file, []);
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
    headerRow.createDiv({ text: file.basename, cls: 'parallel-reader-title' });
    const actions = headerRow.createDiv({ cls: 'parallel-reader-actions' });
    addIconButton(
      actions,
      'square',
      this.plugin.t('actionCancel'),
      () => {
        this.plugin.cancelGenerationForFile(file);
      },
      this.tr,
    );

    const state = container.createDiv({
      cls: 'parallel-reader-state parallel-reader-loading parallel-reader-streaming-preview',
    });
    state.createDiv({ cls: 'parallel-reader-spinner' });
    const titleEl = state.createDiv({ cls: 'parallel-reader-state-title' });
    titleEl.createSpan({ text: this.plugin.t('loadingGenerating') + ' ' });
    titleEl.createSpan({ cls: 'parallel-reader-stream-counter', text: `${text.length} chars` });
    const pre = state.createEl('pre', { cls: 'parallel-reader-stream-text' });
    pre.textContent = text.slice(-2000);
  }

  renderError(file: TFile, message: string) {
    this.beginSectionsReplace(file, []);
    this.stale = false;
    this.loadingMessage = '';
    this.errorMessage = message || this.plugin.t('errorTitle');
    this.render();
  }

  renderEmptyWithHint(file: TFile) {
    this.beginSectionsReplace(file, []);
    this.stale = false;
    this.loadingMessage = '';
    this.errorMessage = '';
    const container = this.containerEl.children[1];
    container.empty();
    const hint = container.createDiv({ cls: 'parallel-reader-empty' });
    hint.createEl('h3', { text: file.basename });
    hint.createEl('p', { text: this.plugin.t('emptyNoCache') });
    hint.createEl('code', { text: this.plugin.t('commandGenerate') });
    this.appendSetupNudge(hint);
    addTextButton(
      hint,
      null,
      this.plugin.t('actionGenerate'),
      () => {
        if (this.plugin.isGeneratingFile(file)) return;
        void this.plugin.runForFile(file, false);
      },
      this.tr,
    );
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
    headerRow.createDiv({ text: this.sourceFile?.basename || '', cls: 'parallel-reader-title' });
    const actions = headerRow.createDiv({ cls: 'parallel-reader-actions' });
    if (this.sourceFile) {
      if (this.plugin.isGeneratingFile(this.sourceFile)) {
        addIconButton(
          actions,
          'square',
          this.plugin.t('actionCancel'),
          () => {
            this.plugin.cancelGenerationForFile(this.sourceFile);
          },
          this.tr,
        );
      } else {
        addIconButton(
          actions,
          'refresh-cw',
          this.plugin.t('actionRegenerate'),
          () => void this.plugin.runForFile(this.sourceFile, true),
          this.tr,
        );
      }
      addIconButton(
        actions,
        'copy',
        this.plugin.t('actionCopyAll'),
        () => void this.plugin.copyCurrentViewMarkdown(),
        this.tr,
      );
      addIconButton(actions, 'download', this.plugin.t('actionExport'), () => void this.exportToVault(), this.tr);
    }
  }

  private renderStaleBanner(container: Element) {
    const banner = container.createDiv({ cls: 'parallel-reader-stale-banner' });
    const icon = banner.createSpan({ cls: 'parallel-reader-stale-icon' });
    if (typeof setIcon === 'function') setIcon(icon, 'alert-triangle');
    banner.createSpan({ text: this.plugin.t('staleBanner'), cls: 'parallel-reader-stale-text' });
    addTextButton(
      banner,
      'refresh-cw',
      this.plugin.t('actionRegenerate'),
      () => void this.plugin.runForFile(this.sourceFile, true),
      this.tr,
      'parallel-reader-stale-button',
    );
  }

  private renderLoadingState(container: Element) {
    const state = container.createDiv({ cls: 'parallel-reader-state parallel-reader-loading' });
    state.createDiv({ cls: 'parallel-reader-spinner' });
    state.createDiv({ text: this.loadingMessage, cls: 'parallel-reader-state-title' });
    state.createDiv({ text: this.plugin.t('loadingSubtitle'), cls: 'parallel-reader-state-subtitle' });
  }

  private renderErrorState(container: Element) {
    const state = container.createDiv({ cls: 'parallel-reader-state parallel-reader-error' });
    state.createDiv({ text: this.plugin.t('errorTitle'), cls: 'parallel-reader-state-title' });
    state.createDiv({
      text: this.errorMessage,
      cls: 'parallel-reader-state-subtitle parallel-reader-selectable',
    });
    const actions = state.createDiv({ cls: 'parallel-reader-error-actions' });
    addTextButton(
      actions,
      'refresh-cw',
      this.plugin.t('actionRegenerate'),
      () => void this.plugin.runForFile(this.sourceFile, true),
      this.tr,
      'parallel-reader-text-button',
    );
    addTextButton(
      actions,
      'copy',
      this.plugin.t('actionCopyError'),
      () => void copyToClipboard(this.errorMessage, this.plugin.t('actionCopyError'), this.tr),
      this.tr,
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

    const title = card.createDiv({ cls: 'parallel-reader-card-title' });
    title.createSpan({ text: s.title });
    if (s.startLine < 0) {
      title.createSpan({ text: ' ⚠', cls: 'parallel-reader-warn', title: this.plugin.t('anchorMismatch') });
    }

    if (s.gist) {
      const gistEl = card.createDiv({ cls: 'parallel-reader-gist' });
      MarkdownRenderer.render(this.app, s.gist, gistEl, sourcePath, this).catch(() => {
        gistEl.setText(s.gist);
      });
    }

    const bs = s.bullets || [];
    if (bs.length > 0) {
      const bulletsEl = card.createDiv({ cls: 'parallel-reader-bullets-md' });
      const md = bs.map((b) => `- ${b}`).join('\n');
      MarkdownRenderer.render(this.app, md, bulletsEl, sourcePath, this).catch(() => {
        bulletsEl.setText(md);
      });
    } else if (!s.gist) {
      card.createDiv({ cls: 'parallel-reader-empty-li', text: this.plugin.t('emptyCard') });
    }

    card.addEventListener('click', (e) => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === 'A') return;
      if (s.startLine < 0) return;
      // Own the highlight immediately: don't wait for the scroll-sync handler
      // to (maybe) agree, since its centered-scroll probe can otherwise land
      // on the preceding card and steal it back (see SCROLL_SYNC_CLICK_SUPPRESS_MS).
      this.setActiveSection(i);
      this.suppressScrollSync();
      void this.plugin.scrollEditorToLine(s.startLine, this.sourceFile);
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
        .onClick(() => void copyToClipboard(cardToMarkdown(s), this.plugin.t('copiedMarkdown'), this.tr)),
    );
    menu.addItem((it) =>
      it
        .setTitle(this.plugin.t('menuCopyPlain'))
        .setIcon('clipboard-copy')
        .onClick(() => void copyToClipboard(cardToPlain(s), this.plugin.t('copiedPlain'), this.tr)),
    );
    if (s.anchor) {
      menu.addItem((it) =>
        it
          .setTitle(this.plugin.t('menuCopyAnchor'))
          .setIcon('quote-glyph')
          .onClick(() => void copyToClipboard(s.anchor, this.plugin.t('copiedAnchor'), this.tr)),
      );
    }
    menu.addSeparator();
    if (s.startLine >= 0) {
      menu.addItem((it) =>
        it
          .setTitle(this.plugin.t('menuJumpSource'))
          .setIcon('arrow-right')
          .onClick(() => void this.plugin.scrollEditorToLine(s.startLine, this.sourceFile)),
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
      this.cards[idx].scrollIntoView({ block: 'nearest', behavior: this.scrollSyncBehavior() });
    }
  }

  /**
   * `smooth` normally; `auto` (instant, no animation) when the user has
   * requested reduced motion. `Element.scrollIntoView`'s explicit `behavior`
   * option overrides the CSS `scroll-behavior` property, so a
   * `prefers-reduced-motion` media query in styles.css alone cannot suppress
   * this JS-driven scroll -- it has to be checked here instead.
   */
  private scrollSyncBehavior(): ScrollBehavior {
    const prefersReduced =
      typeof activeWindow.matchMedia === 'function' &&
      activeWindow.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return prefersReduced ? 'auto' : 'smooth';
  }

  /** Arms the click-vs-scroll-sync suppression window (see SCROLL_SYNC_CLICK_SUPPRESS_MS). */
  private suppressScrollSync() {
    this.scrollSyncSuppressedUntil = Date.now() + SCROLL_SYNC_CLICK_SUPPRESS_MS;
  }

  /** Whether the scroll-sync handler should skip reassigning the active card right now. */
  isScrollSyncSuppressed(): boolean {
    return Date.now() < this.scrollSyncSuppressedUntil;
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

  /**
   * True when the panel still shows the note a pending write was started on.
   *
   * `cacheReplaceCards` is awaited, and the user can open another note during that
   * await. The cache write is still correct — it targets the captured path — but
   * committing the resulting VIEW state unconditionally used to repaint the newly
   * opened note with the previous note's cards.
   */
  private stillShowing(sourcePath: string): boolean {
    return this.sourceFile?.path === sourcePath;
  }

  /**
   * Runs card mutations one at a time, so that computing a replacement array,
   * persisting it, and committing the visible state form ONE ordered step.
   *
   * Two mutations issued before the first one's write landed used to compute their
   * payloads from the same untouched `sections` array and then race: the later, stale
   * payload silently overwrote the earlier successful one, and BOTH reported success
   * (deleting cards 0 and 1 wrote `[b,c]` and then `[a,c]`, ending at `[a,c]` instead of
   * `[c]`). Serializing the cache writes cannot fix that — by the time a write is
   * ordered, its payload was computed from a snapshot that is already stale. The
   * computation and the persistence have to share a single ordering boundary, and this
   * queue is it.
   *
   * Deadlock safety: a link only ever awaits `plugin.cacheReplaceCards`, i.e.
   * CacheManager's own transaction queue. CacheManager never calls back into the view —
   * its transaction bodies touch only its lock-free internals and the vault adapter — so
   * no cache transaction can wait on this queue while this queue waits on it. The
   * dependency is strictly one-way: view queue → cache queue.
   *
   * Invariant: the tail never rejects, so one failed mutation cannot wedge every later
   * one. Each caller still sees its own outcome through the promise it is handed.
   */
  private cardMutationQueue: Promise<void> = Promise.resolve();

  /**
   * The card array this queue last treated as authoritative, and for which note.
   *
   * Consulted ONLY when the panel moved to a different note while a mutation was still
   * queued: the view no longer holds that note's cards, but the link that ran before
   * this one does. On a successful write this is the array that was persisted; on a
   * failed one it is the array the write was computed from, which is what disk still
   * holds.
   */
  private lastMutationState: { path: string; sections: ResolvedCard[] } | null = null;

  private enqueueCardMutation(task: () => Promise<boolean>): Promise<boolean> {
    const run = this.cardMutationQueue.then(task);
    this.cardMutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * The array a queued mutation must compute from at the moment it actually runs.
   *
   * Normally the view's own `sections`: every mutation that ran before this one already
   * committed into it, which is exactly what makes the second of two concurrent edits
   * see the first one's result instead of a stale snapshot. `snapshot` (the array the
   * user was looking at when they acted) is the last resort, for a mutation whose note
   * left the panel before it could run and that has no predecessor to inherit from.
   */
  private cardMutationBase(sourcePath: string, snapshot: ResolvedCard[]): ResolvedCard[] {
    if (this.stillShowing(sourcePath)) return this.sections;
    if (this.lastMutationState?.path === sourcePath) return this.lastMutationState.sections;
    return snapshot;
  }

  /**
   * Persist `nextSections` for `sourcePath` and record what the queue should treat as
   * authoritative afterwards. Never throws: a rejected write is reported as `false`, so
   * the caller leaves every piece of visible state untouched (S8, hole 2).
   */
  private async persistCards(
    sourcePath: string,
    base: ResolvedCard[],
    nextSections: ResolvedCard[],
    failureLabel: string,
  ): Promise<boolean> {
    let ok = false;
    try {
      ok = await this.plugin.cacheReplaceCards(sourcePath, nextSections);
    } catch (e: unknown) {
      console.error(failureLabel, e);
      ok = false;
    }
    this.lastMutationState = { path: sourcePath, sections: ok ? nextSections : base };
    return ok;
  }

  async deleteCard(index: number): Promise<boolean> {
    if (!this.sourceFile) return false;
    const sourcePath = this.sourceFile.path;
    // Capture WHICH card the user acted on (by identity) and the list they saw it in,
    // synchronously, before anything is awaited. Positions shift under a mutation that
    // runs first; the card the user right-clicked does not.
    const snapshot = this.sections;
    const target = snapshot[index];
    if (!target) return false;

    return this.enqueueCardMutation(async () => {
      const base = this.cardMutationBase(sourcePath, snapshot);
      const targetIdx = base.indexOf(target);
      // Already removed by a mutation that ran first — nothing left to delete.
      if (targetIdx < 0) return false;
      const nextSections = removeCardAt(base, targetIdx);

      // Await the cache write BEFORE touching any visible state. `removeCardAt`/
      // `updateCardAt` always return fresh arrays (never mutate in place), so nothing is
      // changed yet and a failed write has nothing to restore (S8, hole 2).
      const ok = await this.persistCards(
        sourcePath,
        base,
        nextSections,
        '[parallel-reader] failed to persist card delete',
      );
      if (!ok) {
        new Notice(this.plugin.t('cardPersistFailed'));
        return false;
      }

      new Notice(this.plugin.t('cardDeleted'));
      // The write above is committed either way; only the visible state is conditional.
      if (!this.stillShowing(sourcePath)) return true;
      this.activeIdx = activeIndexAfterCardDelete(targetIdx, base.length, this.activeIdx);
      this.sections = nextSections;
      this.render();
      return true;
    });
  }

  openEditCardModal(index: number) {
    if (!this.sourceFile || !this.sections[index]) return false;
    new CardEditModal(this.app, this.plugin, this.sections[index], async (patch) => {
      await this.updateCard(index, patch);
    }).open();
    return true;
  }

  async updateCard(index: number, patch: CardPatch): Promise<boolean> {
    if (!this.sourceFile) return false;
    const sourcePath = this.sourceFile.path;
    // Same identity capture + queue as deleteCard (see the comments there).
    const snapshot = this.sections;
    const target = snapshot[index];
    if (!target) return false;

    return this.enqueueCardMutation(async () => {
      const base = this.cardMutationBase(sourcePath, snapshot);
      const targetIdx = base.indexOf(target);
      if (targetIdx < 0) return false;
      const nextSections = updateCardAt(base, targetIdx, patch);

      const ok = await this.persistCards(
        sourcePath,
        base,
        nextSections,
        '[parallel-reader] failed to persist card update',
      );
      if (!ok) {
        new Notice(this.plugin.t('cardPersistFailed'));
        return false;
      }

      new Notice(this.plugin.t('cardSaved'));
      // See deleteCard: the note may have changed under the await.
      if (!this.stillShowing(sourcePath)) return true;
      this.sections = nextSections;
      this.render();
      return true;
    });
  }

  async exportToVault() {
    if (!this.sourceFile) return;
    const folder = normalizeVaultPath(this.plugin.settings.exportFolder);
    const name = `${this.sourceFile.basename} - ${this.plugin.t('displayName')}.md`;
    const targetPath = `${folder}/${name}`;

    const markdown = [
      '---',
      `source: [[${this.sourceFile.path}|${this.sourceFile.basename}]]`,
      `generated: ${new Date().toISOString().slice(0, 10)}`,
      'tool: parallel-reader',
      '---',
      '',
      cardsToMarkdown(`${this.sourceFile.basename} · ${this.plugin.t('displayName')}`, this.sections),
      '',
    ].join('\n');

    const app = this.plugin.app;
    try {
      await ensureVaultFolder(app, folder);
      const existing = app.vault.getAbstractFileByPath(targetPath);
      if (existing instanceof TFile) {
        const shouldOverwrite = await confirmExportOverwrite(
          this.app,
          this.plugin.t('displayName'),
          this.plugin.t('confirmExportOverwrite', { path: targetPath }),
          this.plugin.t('confirmExportCancel'),
          this.plugin.t('confirmExportOverwriteButton'),
        );
        if (!shouldOverwrite) {
          new Notice(this.plugin.t('exportCancelled'));
          return;
        }
        await app.vault.modify(existing, markdown);
      } else {
        await app.vault.create(targetPath, markdown);
      }
      new Notice(this.plugin.t('exported', { path: targetPath }));
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);
      console.error('[parallel-reader] exportToVault failed', e);
      new Notice(this.plugin.t('exportFailed', { error }));
    }
  }
}
