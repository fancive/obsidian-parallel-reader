'use strict';
import { MarkdownView, Notice, Plugin, requestUrl, TFile } from 'obsidian';
import { findLineForAnchor } from './src/anchor';
import { serializeCacheFile, shouldConfirmRegenerate, touchCacheEntry } from './src/cache';
import { CacheManager } from './src/cache-manager';
import { activeIndexAfterCardDelete, removeCardAt, updateCardAt } from './src/cards';
import { resolveCliPath, summarizeViaClaudeCode, summarizeViaCodex } from './src/cli';
import {
  classifyGenerationError,
  type GenerationJob,
  GenerationJobAlreadyRunningError,
  GenerationJobCancelledError,
  GenerationJobManager,
} from './src/generation-job-manager';
import { translate } from './src/i18n';
import { cardsToMarkdown } from './src/markdown';
import { activeSectionLine, nextCardIndex } from './src/navigation';
import { buildPrompts } from './src/prompt';
import {
  buildAnthropicMessagesBody,
  buildGeminiBody,
  buildOpenAiChatBody,
  buildOpenAiResponsesBody,
  summarizeViaApi,
  summarizeViaApiStreaming,
  supportsStreaming,
  tokenLimitFieldForOpenAiChat,
} from './src/providers';
import { extractJson, normalizeCardsPayload } from './src/schema';
import { createRafThrottledHandler, visibleTopProbeY } from './src/scroll';
import {
  CACHE_SCHEMA_VERSION,
  cacheEntryMatches,
  DEFAULT_SETTINGS,
  generationFingerprint,
  getApiBaseUrl,
  isApiBackend,
  modelForApi,
  normalizeSettings,
  pruneCacheEntries,
} from './src/settings';
import { ParallelReaderSettingTab } from './src/settings-tab';
import { deltaExtractorForFormat, parseSseBuffer, type StreamProgress } from './src/streaming';
import type { CacheEntry, PluginSettings, RawCard, ResolvedCard } from './src/types';
import { addIconButton, addTextButton, copyToClipboard } from './src/ui-helpers';
import { folderPathsForTarget } from './src/vault';
import { ParallelReaderView, VIEW_TYPE_PARALLEL } from './src/view';

/* ---------- Helpers ---------- */

async function summarizeDocument(
  content: string,
  settings: PluginSettings,
  job: GenerationJob,
  onStreamProgress?: (progress: StreamProgress) => void,
) {
  const { system, user } = buildPrompts(content, settings);
  let cards: RawCard[];
  switch (settings.backend) {
    case 'claude-code':
      cards = await summarizeViaClaudeCode(system, user, settings, job);
      break;
    case 'codex':
      cards = await summarizeViaCodex(system, user, settings, job);
      break;
    default: {
      const useStreaming = supportsStreaming(settings);
      const abortController = useStreaming ? new AbortController() : null;
      if (abortController) {
        job.onCancel(() => abortController.abort());
      }
      if (useStreaming) {
        cards = await summarizeViaApiStreaming(system, user, settings, onStreamProgress, abortController!.signal);
      } else {
        cards = await summarizeViaApi(requestUrl, system, user, settings);
      }
      break;
    }
  }
  const resolved: ResolvedCard[] = cards.map((c) => ({
    title: c.title,
    level: 2,
    anchor: c.anchor,
    gist: c.gist,
    startLine: findLineForAnchor(content, c.anchor),
    bullets: c.bullets,
  }));
  resolved.sort((a, b) => {
    if (a.startLine < 0 && b.startLine < 0) return 0;
    if (a.startLine < 0) return 1;
    if (b.startLine < 0) return -1;
    return a.startLine - b.startLine;
  });
  return resolved;
}

function cancellationNoticeKey(settings: PluginSettings | null, job: GenerationJob | null) {
  if (job?.phase === 'generating' && settings && isApiBackend(settings.backend)) {
    return 'cancelRequestedApiInFlight';
  }
  return 'cancelRequested';
}

/* ---------- Plugin ---------- */

class ParallelReaderPlugin extends Plugin {
  settings!: PluginSettings;
  cacheManager!: CacheManager;
  jobs!: GenerationJobManager;
  _scrollDispose: (() => void) | null = null;
  _settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;

  get cache(): Record<string, CacheEntry> {
    return this.cacheManager.cache;
  }

  t(key: string, vars?: Record<string, string | number>) {
    return translate(this.settings || DEFAULT_SETTINGS, key, vars);
  }

  async onload() {
    await this.loadSettings();
    this.jobs = new GenerationJobManager();

    this.addRibbonIcon('book-open', this.t('ribbonOpen'), async () => {
      const active = this.getActiveView();
      await this.ensureView();
      if (active?.file) await this.syncViewToFile(active.file);
    });

    this.registerView(VIEW_TYPE_PARALLEL, (leaf) => new ParallelReaderView(leaf, this));

    this.addCommand({
      id: 'parallel-reader-run',
      name: this.t('cmdRun'),
      callback: () => this.runForActiveFile(false),
    });
    this.addCommand({
      id: 'parallel-reader-regen',
      name: this.t('cmdRegen'),
      callback: () => this.runForActiveFile(true),
    });
    this.addCommand({
      id: 'parallel-reader-open-view',
      name: this.t('cmdOpenView'),
      callback: async () => {
        const active = this.getActiveView();
        await this.ensureView();
        if (active?.file) this.syncViewToFile(active.file);
      },
    });
    this.addCommand({
      id: 'parallel-reader-export-current',
      name: this.t('cmdExport'),
      callback: () => this.exportCurrentView(),
    });
    this.addCommand({
      id: 'parallel-reader-copy-current-markdown',
      name: this.t('cmdCopyMarkdown'),
      callback: () => this.copyCurrentViewMarkdown(),
    });
    this.addCommand({
      id: 'parallel-reader-cancel-current',
      name: this.t('cmdCancel'),
      callback: () => this.cancelActiveGeneration(),
    });
    this.addCommand({
      id: 'parallel-reader-clear-current',
      name: this.t('cmdClearCurrent'),
      callback: async () => {
        const active = this.getActiveView();
        if (!active?.file) return new Notice(this.t('noCurrentNote'));
        await this.cacheManager.delete(active.file.path);
        new Notice(this.t('cacheClearedFile', { name: active.file.basename }));
      },
    });
    this.addCommand({
      id: 'parallel-reader-clear-all',
      name: this.t('cmdClearAll'),
      callback: async () => {
        const n = Object.keys(this.cacheManager.cache).length;
        await this.cacheManager.clear();
        new Notice(this.t('cacheClearedAll', { count: n }));
      },
    });
    this.addCommand({
      id: 'parallel-reader-card-prev',
      name: this.t('cmdCardPrev'),
      hotkeys: [{ modifiers: ['Alt'], key: 'ArrowUp' }],
      callback: () => this.moveActiveCard(-1),
    });
    this.addCommand({
      id: 'parallel-reader-card-next',
      name: this.t('cmdCardNext'),
      hotkeys: [{ modifiers: ['Alt'], key: 'ArrowDown' }],
      callback: () => this.moveActiveCard(1),
    });
    this.addCommand({
      id: 'parallel-reader-card-jump',
      name: this.t('cmdCardJump'),
      callback: () => this.jumpActiveCard(),
    });

    this.addSettingTab(new ParallelReaderSettingTab(this.app, this));

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.bindScrollSync()));
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file) this.syncViewToFile(file);
      }),
    );
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => this.addFileMenuItems(menu, file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.handleFileRename(file as TFile, oldPath)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.handleFileDelete(file as TFile)));
    this.bindScrollSync();
  }

  async onunload() {
    await this.flushSettingsSave();
    await this.flushCacheSave();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_PARALLEL);
  }

  /* ---------- Settings persistence ---------- */

  async loadSettings() {
    const data = (await this.loadData()) || {};
    const settingsBlob = data.settings || {};
    this.settings = normalizeSettings(Object.assign({}, DEFAULT_SETTINGS, settingsBlob));
    this.cacheManager = new CacheManager(
      this.app.vault.adapter,
      this.app.vault.configDir || '.obsidian',
      this.manifest?.id || 'parallel-reader',
      () => this.settings,
    );
    await this.cacheManager.load();
  }

  async saveSettings() {
    if (this._settingsSaveTimer) {
      clearTimeout(this._settingsSaveTimer);
      this._settingsSaveTimer = null;
    }
    await this.saveData({ settings: this.settings });
  }

  saveSettingsDebounced(delayMs = 400) {
    if (this._settingsSaveTimer) clearTimeout(this._settingsSaveTimer);
    this._settingsSaveTimer = setTimeout(() => {
      this._settingsSaveTimer = null;
      this.saveSettings().catch((e) => console.error('[parallel-reader] failed to save settings', e));
    }, delayMs);
  }

  async flushSettingsSave() {
    if (!this._settingsSaveTimer) return;
    clearTimeout(this._settingsSaveTimer);
    this._settingsSaveTimer = null;
    await this.saveSettings();
  }

  /* ---------- Cache delegation ---------- */

  async cacheTouch(filePath: string) {
    return this.cacheManager.touch(filePath);
  }
  scheduleCacheSave(delayMs = 5000) {
    this.cacheManager.scheduleSave(delayMs);
  }
  async flushCacheSave() {
    await this.cacheManager.flush();
  }
  async cacheReplaceCards(filePath: string, cards: ResolvedCard[]) {
    return this.cacheManager.replaceCards(filePath, cards);
  }
  async cacheClear() {
    return this.cacheManager.clear();
  }
  async pruneCacheIfNeeded() {
    return this.cacheManager.pruneIfNeeded();
  }

  /* ---------- View management ---------- */

  async ensureView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_PARALLEL)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_PARALLEL, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf.view as ParallelReaderView;
  }

  getActiveView() {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }
  getParallelView() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL)[0]?.view as ParallelReaderView | undefined;
  }

  moveActiveCard(delta: number) {
    const view = this.getParallelView();
    if (!view?.sections.length) {
      new Notice(this.t('noActiveCard'));
      return -1;
    }
    return view.moveActiveSection(delta);
  }

  jumpActiveCard() {
    const view = this.getParallelView();
    if (!view || view.jumpToActiveSection() < 0) {
      new Notice(this.t('noActiveCard'));
      return false;
    }
    return true;
  }

  isGeneratingFile(file: TFile | null) {
    return !!file && !!file.path && this.jobs.isRunning(file.path);
  }

  cancelGenerationForFile(file: TFile | null) {
    if (!file?.path) {
      new Notice(this.t('noCancelableJob'));
      return false;
    }
    const job = this.jobs.get(file.path);
    const noticeKey = cancellationNoticeKey(this.settings, job);
    const cancelled = this.jobs.cancel(file.path);
    new Notice(cancelled ? this.t(noticeKey) : this.t('noCancelableJob'));
    return cancelled;
  }

  viewIsShowingFile(view: ParallelReaderView | null, file: TFile) {
    return !!view && !!file && view.sourceFile?.path === file.path;
  }
  activeFileStillMatches(file: TFile) {
    const active = this.getActiveView();
    return !active?.file || active.file.path === file.path;
  }

  cancelActiveGeneration() {
    const active = this.getActiveView();
    if (active?.file && this.cancelGenerationForFile(active.file)) return;
    const view = this.getParallelView();
    if (view?.sourceFile) this.cancelGenerationForFile(view.sourceFile);
    else new Notice(this.t('noCancelableJob'));
  }

  confirmRegenerateEditedCards() {
    const message = this.t('confirmRegenerateEditedCards');
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') return window.confirm(message);
    return true;
  }

  addFileMenuItems(menu: any, file: any) {
    if (!(file instanceof TFile) || !file.path.endsWith('.md')) return;
    menu.addSeparator();
    menu.addItem((it: any) =>
      it
        .setTitle(this.t('fileMenuGenerate'))
        .setIcon('book-open')
        .onClick(() => this.runForFile(file, false)),
    );
    menu.addItem((it: any) =>
      it
        .setTitle(this.t('fileMenuRegen'))
        .setIcon('refresh-cw')
        .onClick(() => this.runForFile(file, true)),
    );
    if (this.cacheManager.get(file.path)) {
      menu.addItem((it: any) =>
        it
          .setTitle(this.t('fileMenuClear'))
          .setIcon('trash')
          .onClick(async () => {
            await this.cacheManager.delete(file.path);
            new Notice(this.t('cacheClearedFile', { name: file.basename }));
          }),
      );
    }
  }

  async handleFileRename(file: TFile, oldPath: string) {
    if (!(file instanceof TFile) || !oldPath) return;
    const wasMarkdown = oldPath.endsWith('.md');
    const isMarkdown = file.path.endsWith('.md');
    if (!wasMarkdown && !isMarkdown) return;
    if (wasMarkdown && !isMarkdown) {
      await this.cacheManager.delete(oldPath);
      const view = this.getParallelView();
      if (view && view.sourceFile?.path === oldPath) view.renderEmpty();
      return;
    }
    if (!wasMarkdown) return;
    if (this.cacheManager.cache[oldPath]) {
      this.cacheManager.cache[file.path] = this.cacheManager.cache[oldPath];
      delete this.cacheManager.cache[oldPath];
      await this.cacheManager.save();
    }
    const view = this.getParallelView();
    if (view?.sourceFile && (view.sourceFile.path === oldPath || view.sourceFile.path === file.path)) {
      view.sourceFile = file;
      await this.syncViewToFile(file);
    }
  }

  async handleFileDelete(file: TFile) {
    if (!(file instanceof TFile)) return;
    await this.cacheManager.delete(file.path);
    const view = this.getParallelView();
    if (view?.sourceFile?.path === file.path) view.renderEmpty();
  }

  async exportCurrentView() {
    const active = this.getActiveView();
    const view = await this.ensureView();
    if (!view.sourceFile || !view.sections.length) {
      if (active?.file) await this.syncViewToFile(active.file);
    }
    if (!view.sourceFile || !view.sections.length) {
      new Notice(this.t('noExportContent'));
      return;
    }
    await view.exportToVault();
  }

  async copyCurrentViewMarkdown() {
    const active = this.getActiveView();
    const view = await this.ensureView();
    if (!view.sourceFile || !view.sections.length) {
      if (active?.file) await this.syncViewToFile(active.file);
    }
    if (!view.sourceFile || !view.sections.length) {
      new Notice(this.t('noCopyContent'));
      return;
    }
    await copyToClipboard(
      cardsToMarkdown(`${view.sourceFile.basename} · ${this.t('displayName')}`, view.sections),
      this.t('copiedAllMarkdown'),
    );
  }

  /* ---------- Generation ---------- */

  async runForActiveFile(force: boolean) {
    const mdView = this.getActiveView();
    if (!mdView?.file) {
      new Notice(this.t('openNoteFirst'));
      return;
    }
    return this.runForFile(mdView.file, force);
  }

  async runForFile(file: TFile | null, force: boolean) {
    if (!file) {
      new Notice(this.t('openNoteFirst'));
      return;
    }
    if (this.jobs.isRunning(file.path)) {
      new Notice(this.t('alreadyGenerating'));
      return;
    }
    if (shouldConfirmRegenerate(this.cacheManager.get(file.path), force) && !this.confirmRegenerateEditedCards()) {
      new Notice(this.t('regenerateCancelled'));
      return;
    }

    let view: ParallelReaderView | null = null;
    return this.jobs
      .start(file.path, async (job) => {
        job.setPhase('reading');
        const content = await this.app.vault.read(file);
        job.throwIfCancelled();
        if (!content.trim()) {
          new Notice(this.t('emptyNote'));
          return;
        }

        view = await this.ensureView();
        job.throwIfCancelled();

        job.setPhase('cache-check');
        if (!force) {
          const entry = this.cacheManager.get(file.path);
          if (entry && cacheEntryMatches(entry, content, this.settings)) {
            await this.cacheTouch(file.path);
            if (this.activeFileStillMatches(file))
              await view.loadFor(file, this.resolveCardAnchors(content, entry.cards), false);
            return;
          }
        }

        await view.renderLoading(file, this.t('loadingGenerating'));
        const maxDocChars = Number(this.settings.maxDocChars) || DEFAULT_SETTINGS.maxDocChars;
        if (content.length > maxDocChars) new Notice(this.t('longNoteTruncated', { count: maxDocChars }));
        new Notice(this.t('generatingNotice'));

        job.setPhase('generating');
        const streamProgress = view
          ? (progress: StreamProgress) => {
              if (!progress.done && this.viewIsShowingFile(view, file)) {
                view!.renderStreamingPreview(file, progress.accumulated);
              }
            }
          : undefined;
        const sections = await summarizeDocument(content, this.settings, job, streamProgress);
        job.throwIfCancelled();
        if (sections.length === 0) {
          new Notice(this.t('noCardsReturned'));
          return;
        }
        const rawCards = sections.map((s) => ({ title: s.title, anchor: s.anchor, gist: s.gist, bullets: s.bullets }));
        job.setPhase('saving');
        await this.cacheManager.put(file.path, content, rawCards, this.settings);
        job.throwIfCancelled();
        if (this.viewIsShowingFile(view, file)) await view.loadFor(file, sections, false);
        const unanchored = sections.filter((s) => s.startLine < 0).length;
        new Notice(
          this.t('generationDone', {
            count: sections.length,
            suffix: unanchored ? this.t('unanchoredSuffix', { count: unanchored }) : '',
          }),
        );
      })
      .catch(async (e) => {
        if (e instanceof GenerationJobAlreadyRunningError) {
          new Notice(e.message);
          return;
        }
        if (e instanceof GenerationJobCancelledError) {
          if (view && this.viewIsShowingFile(view, file)) await view.renderError(file, this.t('cancelledError'));
          new Notice(this.t('cancelled'));
          return;
        }
        const kind = classifyGenerationError(e);
        console.error(e);
        if (view && this.viewIsShowingFile(view, file)) await view.renderError(file, e.message || String(e));
        new Notice(this.t('generationFailed', { kind: kind === 'unknown' ? '' : ` (${kind})`, error: e.message || e }));
      });
  }

  resolveCardAnchors(content: string, rawCards: RawCard[]) {
    const resolved: ResolvedCard[] = (rawCards || []).map((c: RawCard) => ({
      title: c.title,
      level: 2,
      anchor: c.anchor,
      gist: c.gist,
      startLine: findLineForAnchor(content, c.anchor),
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

  /* ---------- Scroll sync ---------- */

  async syncViewToFile(file: TFile) {
    if (!file?.path?.endsWith('.md')) return;
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL);
    if (leaves.length === 0) return;
    const view = leaves[0].view as ParallelReaderView;
    if (!view || !this.activeFileStillMatches(file)) return;
    const entry = this.cacheManager.get(file.path);
    if (!entry) {
      await view.loadFor(file, [], false);
      view.renderEmptyWithHint(file);
      return;
    }
    const content = await this.app.vault.read(file);
    if (!this.activeFileStillMatches(file)) return;
    const stale = !cacheEntryMatches(entry, content, this.settings);
    await this.cacheTouch(file.path);
    await view.loadFor(file, this.resolveCardAnchors(content, entry.cards), stale);
  }

  bindScrollSync() {
    if (this._scrollDispose) {
      this._scrollDispose();
      this._scrollDispose = null;
    }
    const mdView = this.getActiveView();
    if (!mdView) return;
    const editor = mdView.editor;
    const cm = editor && (editor as any).cm;
    const scrollDom = cm?.scrollDOM ? cm.scrollDOM : mdView.contentEl.querySelector('.cm-scroller');
    if (!scrollDom) return;
    const handler = createRafThrottledHandler(() => this.handleEditorScroll(mdView));
    scrollDom.addEventListener('scroll', handler, { passive: true });
    this._scrollDispose = () => {
      handler.cancel();
      scrollDom.removeEventListener('scroll', handler);
    };
  }

  handleEditorScroll(mdView: MarkdownView) {
    const view = this.getParallelView();
    if (!view || !mdView.file || view.sourceFile?.path !== mdView.file.path) return;
    const editor = mdView.editor;
    const cm = editor && (editor as any).cm;
    if (!cm?.scrollDOM) return;
    const rect = cm.scrollDOM.getBoundingClientRect();
    const topY = visibleTopProbeY(rect);
    let topLine = 0;
    try {
      const pos = cm.posAtCoords({ x: rect.left + 20, y: topY });
      if (pos != null) topLine = cm.state.doc.lineAt(pos).number - 1;
    } catch (_) {
      return;
    }
    let activeIdx = -1;
    for (let i = 0; i < view.sections.length; i++) {
      const s = view.sections[i];
      if (s.startLine < 0) continue;
      if (s.startLine <= topLine) activeIdx = i;
      else break;
    }
    view.setActiveSection(activeIdx);
  }

  findLeafForFile(file: TFile | null) {
    if (!file) return null;
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view as any;
      if (v?.file && v.file.path === file.path) return leaf;
    }
    return null;
  }

  async scrollEditorToLine(line: number, file: TFile | null) {
    let leaf = file ? this.findLeafForFile(file) : null;
    if (!leaf && file) {
      leaf = this.app.workspace.getLeaf('tab');
      await leaf.openFile(file, { active: false });
    }
    if (!leaf) {
      const active = this.getActiveView();
      if (active) leaf = active.leaf;
    }
    if (!leaf) {
      new Notice(this.t('noEditor'));
      return;
    }
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    const mdView = leaf.view;
    if (!(mdView instanceof MarkdownView)) return;
    mdView.setEphemeralState({ line });
    if (mdView.editor) {
      try {
        mdView.editor.setCursor({ line, ch: 0 });
        mdView.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

export default ParallelReaderPlugin;
export const __test = {
  CACHE_SCHEMA_VERSION,
  GenerationJobAlreadyRunningError,
  GenerationJobCancelledError,
  GenerationJobManager,
  addIconButton,
  addTextButton,
  activeIndexAfterCardDelete,
  activeSectionLine,
  buildAnthropicMessagesBody,
  buildGeminiBody,
  buildOpenAiChatBody,
  buildOpenAiResponsesBody,
  buildPrompts,
  cardsToMarkdown,
  cacheEntryMatches,
  cancellationNoticeKey,
  classifyGenerationError,
  copyToClipboard,
  createRafThrottledHandler,
  extractJson,
  findLineForAnchor,
  folderPathsForTarget,
  generationFingerprint,
  getApiBaseUrl,
  modelForApi,
  normalizeCardsPayload,
  nextCardIndex,
  pruneCacheEntries,
  removeCardAt,
  resolveCliPath,
  serializeCacheFile,
  shouldConfirmRegenerate,
  summarizeViaApi,
  touchCacheEntry,
  translate,
  tokenLimitFieldForOpenAiChat,
  updateCardAt,
  visibleTopProbeY,
  supportsStreaming,
  deltaExtractorForFormat,
  parseSseBuffer,
};
