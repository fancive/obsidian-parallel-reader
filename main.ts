'use strict';
import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import {
  type BatchRunState,
  batchProgressVars,
  createBatchRunState,
  createBatchStats,
  hasUnsafeBatchFolderSegments,
  markBatchFileRunning,
  normalizeBatchFolderInput,
  promptForBatchFolder,
  recordBatchError,
  recordBatchProcessed,
  recordBatchSkip,
  requestBatchCancel,
  selectBatchFiles,
  shouldSkipBatchFile,
  validateBatchFolderInput,
} from './src/batch';
import { serializeCacheFile, shouldConfirmRegenerate, touchCacheEntry } from './src/cache';
import { CacheManager } from './src/cache-manager';
import { findLineForAnchor } from './src/anchor';
import { activeIndexAfterCardDelete, removeCardAt, resolveCardAnchors, updateCardAt } from './src/cards';
import { resolveCliPath, runCli } from './src/cli';
import { cancellationNoticeKey, summarizeDocument } from './src/generation';
import {
  classifyGenerationError,
  GenerationJobAlreadyRunningError,
  GenerationJobCancelledError,
  GenerationJobManager,
} from './src/generation-job-manager';
import { translate } from './src/i18n';
import { cardsToMarkdown } from './src/markdown';
import { confirmRegenerateEditedCards } from './src/modal';
import { activeSectionLine, nextCardIndex } from './src/navigation';
import { buildPrompts } from './src/prompt';
import {
  buildAnthropicMessagesBody,
  buildGeminiBody,
  buildOpenAiChatBody,
  buildOpenAiResponsesBody,
  summarizeViaApi,
  supportsStreaming,
  tokenLimitFieldForOpenAiChat,
} from './src/providers';
import { collectJsonObjectCandidates, extractJson, normalizeCardsPayload, repairTruncatedCardsJson } from './src/schema';
import { createRafThrottledHandler, visibleTopProbeY } from './src/scroll';
import {
  CACHE_SCHEMA_VERSION,
  cacheEntryMatches,
  DEFAULT_SETTINGS,
  generationFingerprint,
  getApiBaseUrl,
  modelForApi,
  normalizeSettings,
  normalizeStreamingTimeoutMs,
  pruneCacheEntries,
} from './src/settings';
import { ParallelReaderSettingTab } from './src/settings-tab';
import { deltaExtractorForFormat, parseSseBuffer, type StreamProgress } from './src/streaming';
import type {
  CacheEntry,
  ObsidianEditorWithCm,
  ObsidianMenu,
  ObsidianMenuItem,
  PluginSettings,
  ResolvedCard,
} from './src/types';
import { addIconButton, addTextButton, copyToClipboard } from './src/ui-helpers';
import { folderPathsForTarget } from './src/vault';
import { ParallelReaderView, VIEW_TYPE_PARALLEL } from './src/view';

/* ---------- Plugin ---------- */

class ParallelReaderPlugin extends Plugin {
  settings!: PluginSettings;
  cacheManager!: CacheManager;
  jobs!: GenerationJobManager;
  activeBatch: BatchRunState | null = null;
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
      const view = await this.ensureView();
      if (!view) return;
      if (active?.file) await this.syncViewToFile(active.file);
    });

    this.registerView(VIEW_TYPE_PARALLEL, (leaf) => new ParallelReaderView(leaf, this));

    this.addCommand({
      id: 'run',
      name: this.t('cmdRun'),
      callback: () => this.runForActiveFile(false),
    });
    this.addCommand({
      id: 'regen',
      name: this.t('cmdRegen'),
      callback: () => this.runForActiveFile(true),
    });
    this.addCommand({
      id: 'open-view',
      name: this.t('cmdOpenView'),
      callback: async () => {
        const active = this.getActiveView();
        const view = await this.ensureView();
        if (!view) return;
        if (active?.file) await this.syncViewToFile(active.file);
      },
    });
    this.addCommand({
      id: 'export-current',
      name: this.t('cmdExport'),
      callback: () => this.exportCurrentView(),
    });
    this.addCommand({
      id: 'copy-current-markdown',
      name: this.t('cmdCopyMarkdown'),
      callback: () => this.copyCurrentViewMarkdown(),
    });
    this.addCommand({
      id: 'cancel-current',
      name: this.t('cmdCancel'),
      callback: () => this.cancelActiveGeneration(),
    });
    this.addCommand({
      id: 'clear-current',
      name: this.t('cmdClearCurrent'),
      callback: async () => {
        const active = this.getActiveView();
        if (!active?.file) {
          new Notice(this.t('noCurrentNote'));
          return;
        }
        await this.cacheManager.delete(active.file.path);
        new Notice(this.t('cacheClearedFile', { name: active.file.basename }));
      },
    });
    this.addCommand({
      id: 'clear-all',
      name: this.t('cmdClearAll'),
      callback: async () => {
        const n = Object.keys(this.cacheManager.cache).length;
        await this.cacheManager.clear();
        new Notice(this.t('cacheClearedAll', { count: n }));
      },
    });
    this.addCommand({
      id: 'card-prev',
      name: this.t('cmdCardPrev'),
      callback: () => this.moveActiveCard(-1),
    });
    this.addCommand({
      id: 'card-next',
      name: this.t('cmdCardNext'),
      callback: () => this.moveActiveCard(1),
    });
    this.addCommand({
      id: 'card-jump',
      name: this.t('cmdCardJump'),
      callback: () => this.jumpActiveCard(),
    });
    this.addCommand({
      id: 'batch-generate',
      name: this.t('cmdBatchGenerate'),
      callback: () => this.runBatchForFolder(),
    });

    this.addSettingTab(new ParallelReaderSettingTab(this.app, this));

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.bindScrollSync()));
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file) this.syncViewToFile(file).catch((e: unknown) => console.error('[parallel-reader] sync view', e));
      }),
    );
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => this.addFileMenuItems(menu, file)));
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile)
          this.handleFileRename(file, oldPath).catch((e: unknown) => console.error('[parallel-reader] file rename', e));
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile)
          this.handleFileDelete(file).catch((e: unknown) => console.error('[parallel-reader] file delete', e));
      }),
    );
    this.bindScrollSync();
  }

  onunload() {
    this.flushSettingsSave().catch((e: unknown) => console.error('[parallel-reader] flush settings on unload', e));
    this.flushCacheSave().catch((e: unknown) => console.error('[parallel-reader] flush cache on unload', e));
  }

  /* ---------- Settings persistence ---------- */

  async loadSettings() {
    const data = (await this.loadData()) || {};
    const settingsBlob = data.settings || {};
    this.settings = normalizeSettings(Object.assign({}, DEFAULT_SETTINGS, settingsBlob));
    this.cacheManager = new CacheManager(
      this.app.vault.adapter,
      this.app.vault.configDir,
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
      this.saveSettings().catch((e: unknown) => console.error('[parallel-reader] failed to save settings', e));
    }, delayMs);
  }

  async flushSettingsSave() {
    if (!this._settingsSaveTimer) return;
    clearTimeout(this._settingsSaveTimer);
    this._settingsSaveTimer = null;
    await this.saveSettings();
  }

  /* ---------- Cache delegation ---------- */

  cacheTouch(filePath: string) {
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

  async ensureView(): Promise<ParallelReaderView | null> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_PARALLEL)[0];
    if (!leaf) {
      const newLeaf = workspace.getRightLeaf(false);
      if (!newLeaf) {
        new Notice(this.t('viewOpenFailed'));
        return null;
      }
      leaf = newLeaf;
      await leaf.setViewState({ type: VIEW_TYPE_PARALLEL, active: true });
    }
    await workspace.revealLeaf(leaf);
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
    if (cancelled && this.activeBatch?.currentPath === file.path) requestBatchCancel(this.activeBatch);
    new Notice(cancelled ? this.t(noticeKey) : this.t('noCancelableJob'));
    return cancelled;
  }

  requestBatchCancellation(): boolean {
    return requestBatchCancel(this.activeBatch);
  }

  viewIsShowingFile(view: ParallelReaderView | null, file: TFile) {
    return !!view && !!file && view.sourceFile?.path === file.path;
  }
  activeFileStillMatches(file: TFile) {
    const active = this.getActiveView();
    return !active?.file || active.file.path === file.path;
  }

  cancelActiveGeneration() {
    if (this.requestBatchCancellation()) {
      const currentPath = this.activeBatch?.currentPath;
      if (currentPath) this.jobs.cancel(currentPath);
      new Notice(this.t('batchCancelRequested'));
      return;
    }
    const active = this.getActiveView();
    if (active?.file && this.cancelGenerationForFile(active.file)) return;
    const view = this.getParallelView();
    if (view?.sourceFile) this.cancelGenerationForFile(view.sourceFile);
    else new Notice(this.t('noCancelableJob'));
  }

  confirmRegenerateEditedCards(): Promise<boolean> {
    return confirmRegenerateEditedCards(this.app, this.t('displayName'), this.t('confirmRegenerateEditedCards'));
  }

  addFileMenuItems(menu: ObsidianMenu, file: unknown) {
    if (!(file instanceof TFile) || !file.path.endsWith('.md')) return;
    menu.addSeparator();
    menu.addItem((it: ObsidianMenuItem) =>
      it
        .setTitle(this.t('fileMenuGenerate'))
        .setIcon('book-open')
        .onClick(() => this.runForFile(file, false)),
    );
    menu.addItem((it: ObsidianMenuItem) =>
      it
        .setTitle(this.t('fileMenuRegen'))
        .setIcon('refresh-cw')
        .onClick(() => this.runForFile(file, true)),
    );
    if (this.cacheManager.get(file.path)) {
      menu.addItem((it: ObsidianMenuItem) =>
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
    await this.cacheManager.move(oldPath, file.path);
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
    if (!view) return;
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
    if (!view) return;
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
    if (
      shouldConfirmRegenerate(this.cacheManager.get(file.path), force) &&
      !(await this.confirmRegenerateEditedCards())
    ) {
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
        if (!view) return;
        job.throwIfCancelled();

        job.setPhase('cache-check');
        if (!force) {
          const entry = this.cacheManager.get(file.path);
          if (entry && cacheEntryMatches(entry, content, this.settings)) {
            this.cacheTouch(file.path);
            if (this.activeFileStillMatches(file))
              view.loadFor(file, resolveCardAnchors(content, entry.cards), false);
            return;
          }
        }

        view.renderLoading(file, this.t('loadingGenerating'));
        const maxDocChars = Number(this.settings.maxDocChars) || DEFAULT_SETTINGS.maxDocChars;
        if (content.length > maxDocChars) new Notice(this.t('longNoteTruncated', { count: maxDocChars }));
        new Notice(this.t('generatingNotice'));

        job.setPhase('generating');
        const streamingView = view;
        const streamProgress = streamingView
          ? (progress: StreamProgress) => {
              if (!progress.done && this.viewIsShowingFile(streamingView, file)) {
                streamingView.renderStreamingPreview(file, progress.accumulated);
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
        if (this.viewIsShowingFile(view, file)) view.loadFor(file, sections, false);
        const unanchored = sections.filter((s) => s.startLine < 0).length;
        new Notice(
          this.t('generationDone', {
            count: sections.length,
            suffix: unanchored ? this.t('unanchoredSuffix', { count: unanchored }) : '',
          }),
        );
      })
      .catch((e: unknown) => {
        if (e instanceof GenerationJobAlreadyRunningError) {
          new Notice(e.message);
          return;
        }
        if (e instanceof GenerationJobCancelledError) {
          if (view && this.viewIsShowingFile(view, file)) view.renderError(file, this.t('cancelledError'));
          new Notice(this.t('cancelled'));
          return;
        }
        const kind = classifyGenerationError(e);
        const msg = e instanceof Error ? e.message : String(e);
        console.error(e);
        if (view && this.viewIsShowingFile(view, file)) view.renderError(file, msg);
        new Notice(this.t('generationFailed', { kind: kind === 'unknown' ? '' : ` (${kind})`, error: msg }));
      });
  }

  async runBatchForFolder() {
    if (this.activeBatch) {
      new Notice(this.t('batchAlreadyRunning'));
      return;
    }
    const folderPath = await promptForBatchFolder(this.app, this.t('batchSelectFolder'), this.t('batchFolderPrompt'));
    if (folderPath === null) return;
    const validation = validateBatchFolderInput(folderPath, (path) => {
      const target = this.app.vault.getAbstractFileByPath(path);
      return !!target && !(target instanceof TFile);
    });
    if (!validation.valid) {
      const noticeKey = validation.reason === 'unsafe' ? 'batchInvalidFolderInput' : 'batchFolderNotFound';
      new Notice(this.t(noticeKey, { path: validation.folderPath || folderPath }));
      return;
    }
    const allFiles = selectBatchFiles(this.app.vault.getMarkdownFiles(), validation.folderPath);
    if (allFiles.length === 0) {
      new Notice(this.t('batchNoMarkdown'));
      return;
    }
    const batch = createBatchRunState();
    this.activeBatch = batch;
    let stats = createBatchStats(allFiles.length);
    try {
      for (let i = 0; i < allFiles.length; i++) {
        if (batch.cancelled) break;
        const file = allFiles[i];
        markBatchFileRunning(batch, file.path);
        new Notice(this.t('batchProgress', batchProgressVars(i, allFiles.length)));
        const content = await this.app.vault.read(file);
        if (batch.cancelled) break;
        const entry = this.cacheManager.get(file.path);
        if (shouldSkipBatchFile(entry, content, this.settings)) {
          stats = recordBatchSkip(stats);
          continue;
        }
        try {
          await this.runForFile(file, false);
          stats = recordBatchProcessed(stats);
        } catch (e: unknown) {
          stats = recordBatchError(stats);
          console.error('[parallel-reader] batch error for', file.path, e);
        }
      }
    } finally {
      if (this.activeBatch === batch) this.activeBatch = null;
    }
    const batchVars: Record<string, string | number> = {
      processed: stats.processed,
      skipped: stats.skipped,
      errors: stats.errors,
      total: stats.total,
    };
    if (batch.cancelled) new Notice(this.t('batchCancelled', batchVars));
    else new Notice(this.t('batchDone', batchVars));
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
      view.loadFor(file, [], false);
      view.renderEmptyWithHint(file);
      return;
    }
    const content = await this.app.vault.read(file);
    if (!this.activeFileStillMatches(file)) return;
    const stale = !cacheEntryMatches(entry, content, this.settings);
    this.cacheTouch(file.path);
    view.loadFor(file, resolveCardAnchors(content, entry.cards), stale);
  }

  bindScrollSync() {
    if (this._scrollDispose) {
      this._scrollDispose();
      this._scrollDispose = null;
    }
    const mdView = this.getActiveView();
    if (!mdView) return;
    const editor = mdView.editor;
    const cm = editor && (editor as unknown as ObsidianEditorWithCm).cm;
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
    const cm = editor && (editor as unknown as ObsidianEditorWithCm).cm;
    if (!cm?.scrollDOM) return;
    const rect = cm.scrollDOM.getBoundingClientRect();
    const topY = visibleTopProbeY(rect);
    let topLine = 0;
    try {
      const pos = cm.posAtCoords({ x: rect.left + 20, y: topY });
      if (pos != null) topLine = cm.state.doc.lineAt(pos).number - 1;
    } catch (_: unknown) {
      /* posAtCoords/lineAt can throw during editor state transitions — safe to ignore */
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
      const v = leaf.view as { file?: TFile };
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
      } catch (_: unknown) {
        /* setCursor/scrollIntoView can throw during view transitions — safe to ignore */
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
  batchProgressVars,
  buildPrompts,
  cardsToMarkdown,
  CacheManager,
  cacheEntryMatches,
  cancellationNoticeKey,
  classifyGenerationError,
  collectJsonObjectCandidates,
  copyToClipboard,
  createRafThrottledHandler,
  createBatchRunState,
  extractJson,
  repairTruncatedCardsJson,
  findLineForAnchor,
  folderPathsForTarget,
  createBatchStats,
  generationFingerprint,
  getApiBaseUrl,
  hasUnsafeBatchFolderSegments,
  markBatchFileRunning,
  modelForApi,
  normalizeBatchFolderInput,
  normalizeCardsPayload,
  normalizeSettings,
  normalizeStreamingTimeoutMs,
  nextCardIndex,
  pruneCacheEntries,
  recordBatchError,
  recordBatchProcessed,
  recordBatchSkip,
  requestBatchCancel,
  removeCardAt,
  resolveCliPath,
  runCli,
  serializeCacheFile,
  shouldConfirmRegenerate,
  shouldSkipBatchFile,
  selectBatchFiles,
  summarizeDocument,
  summarizeViaApi,
  touchCacheEntry,
  translate,
  tokenLimitFieldForOpenAiChat,
  updateCardAt,
  validateBatchFolderInput,
  visibleTopProbeY,
  supportsStreaming,
  deltaExtractorForFormat,
  parseSseBuffer,
};
