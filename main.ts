'use strict';
import { Component, MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import {
  type BatchRunState,
  batchProgressVars,
  createBatchRunState,
  createBatchStats,
  markBatchFileRunning,
  promptForBatchFolder,
  recordBatchError,
  recordBatchProcessed,
  recordBatchSkip,
  requestBatchCancel,
  selectBatchFiles,
  shouldSkipBatchFile,
  validateBatchFolderInput,
} from './src/batch';
import { shouldConfirmRegenerate } from './src/cache';
import { CacheManager } from './src/cache-manager';
import { resolveCardAnchors } from './src/cards';
import { showGenerationError } from './src/error-ui';
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
import { createRafThrottledHandler, visibleTopProbeY } from './src/scroll';
import {
  cacheEntryMatches,
  DEFAULT_SETTINGS,
  getApiAuthType,
  getApiKey,
  isApiBackend,
  normalizeSettings,
} from './src/settings';
import { ParallelReaderSettingTab } from './src/settings-tab';
import type { StreamProgress } from './src/streaming';
import type {
  CacheEntry,
  ObsidianEditorWithCm,
  ObsidianMenu,
  ObsidianMenuItem,
  PluginSettings,
  ResolvedCard,
  RunForFileOptions,
  RunForFileResult,
} from './src/types';
import { copyToClipboard } from './src/ui-helpers';
import { ParallelReaderView, VIEW_TYPE_PARALLEL } from './src/view';

/* ---------- Plugin ---------- */

class ParallelReaderPlugin extends Plugin {
  settings!: PluginSettings;
  cacheManager!: CacheManager;
  jobs!: GenerationJobManager;
  activeBatch: BatchRunState | null = null;
  // Owns the editor scroll listener as a child Component (see bindScrollSync) so a
  // rebind can detach *only* the previous binding via removeChild, and unloading the
  // plugin detaches it automatically through Obsidian's normal Component unload cascade
  // (rather than the previous raw addEventListener, which onunload() never disposed).
  _scrollSync: Component | null = null;
  _settingsSaveTimer: number | null = null;
  /**
   * Tail of the settings-write queue.
   *
   * The debounce callback clears `_settingsSaveTimer` BEFORE the async write settles, so
   * the timer alone cannot tell `flushSettingsSave()` whether a write is still in flight;
   * quit landing in that window used to await nothing and lose the setting. Tracking the
   * pending write in a single slot was not enough either: a second save overwrote the
   * slot, so two writes could be in flight at once, land in either order, and leave an
   * OLDER payload as the final state on disk — while flush, awaiting only the newest
   * slot, reported success. Writes are therefore chained: each starts after the previous
   * one settles, and flush awaits this tail.
   *
   * Invariant: the tail never rejects (errors are swallowed when it is republished), so
   * one failed write cannot wedge every later write. Each caller still sees its own
   * rejection through the promise `saveSettings()` returns.
   */
  _settingsSaveQueue: Promise<void> = Promise.resolve();

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
      callback: () => this.toggleParallelView(),
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
        this.refreshViewAfterCacheDelete(active.file.path);
        new Notice(this.t('cacheClearedFile', { name: active.file.basename }));
      },
    });
    this.addCommand({
      id: 'clear-all',
      name: this.t('cmdClearAll'),
      callback: async () => {
        const n = Object.keys(this.cacheManager.cache).length;
        await this.cacheClear();
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
    // onunload() below still fires best-effort flushes for the plain disable/reload
    // path (the event loop keeps running then, so they usually land), but Obsidian
    // does NOT await onunload — during an actual app quit the process can exit before
    // those floating promises settle. `workspace.on('quit', ...)` + `Tasks.addPromise`
    // is the documented mechanism Obsidian itself waits on before exiting, so it is the
    // only path that can actually guarantee these debounced writes reach disk.
    this.registerEvent(
      this.app.workspace.on('quit', (tasks) => {
        tasks.addPromise(
          this.flushSettingsSave().catch((e: unknown) => console.error('[parallel-reader] flush settings on quit', e)),
        );
        tasks.addPromise(
          this.flushCacheSave().catch((e: unknown) => console.error('[parallel-reader] flush cache on quit', e)),
        );
      }),
    );
    this.bindScrollSync();
  }

  onunload() {
    if (this.jobs) this.jobs.cancelAll();
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
      activeWindow.clearTimeout(this._settingsSaveTimer);
      this._settingsSaveTimer = null;
    }
    // Queue behind any write already running or queued, so writes reach disk in the
    // order they were requested and the last one requested is the last one committed.
    // `this.settings` is read when this link runs, not now, so a queued write always
    // persists the current settings rather than a snapshot that is already stale.
    const run = this._settingsSaveQueue.then(() => Promise.resolve(this.saveData({ settings: this.settings })));
    this._settingsSaveQueue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  saveSettingsDebounced(delayMs = 400) {
    if (this._settingsSaveTimer) activeWindow.clearTimeout(this._settingsSaveTimer);
    this._settingsSaveTimer = activeWindow.setTimeout(() => {
      this._settingsSaveTimer = null;
      this.saveSettings().catch((e: unknown) => console.error('[parallel-reader] failed to save settings', e));
    }, delayMs);
  }

  async flushSettingsSave() {
    if (this._settingsSaveTimer) {
      activeWindow.clearTimeout(this._settingsSaveTimer);
      this._settingsSaveTimer = null;
      // saveSettings() enqueues behind everything already pending and awaits its own
      // link, so awaiting it also awaits every write queued before it.
      await this.saveSettings();
      return;
    }
    // A debounce that already fired has no timer left, but its write can still be in
    // flight — and older writes can still be queued behind a newer one that already
    // resolved. Await the TAIL, so the quit hook holds until the queue is fully drained;
    // resolving early would let the process exit mid-queue and leave a stale payload as
    // the last thing written.
    await this._settingsSaveQueue;
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
    await this.cacheManager.clear();
    // Keep this delegation in sync with the `clear-all` command below, which
    // has always refreshed the view after clearing — the Settings tab's
    // "Clear all cache" button used to skip this and leave dead cards on
    // screen (S8, hole 1).
    this.refreshViewAfterCacheClear();
  }
  async pruneCacheIfNeeded() {
    return this.cacheManager.pruneIfNeeded();
  }

  /* ---------- View management ---------- */

  /**
   * Open the panel if it does not exist yet; otherwise toggle the right
   * sidebar's collapsed state. The leaf itself is preserved across toggles —
   * we never detach it, so the panel content survives a hide/show cycle.
   */
  async toggleParallelView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL);
    if (leaves.length === 0) {
      const active = this.getActiveView();
      const view = await this.ensureView();
      if (!view) return;
      if (active?.file) await this.syncViewToFile(active.file);
      return;
    }
    const rightSplit = this.app.workspace.rightSplit;
    if (rightSplit?.collapsed) {
      // Sidebar collapsed → expand and focus our tab.
      await this.app.workspace.revealLeaf(leaves[0]);
    } else if (rightSplit) {
      // Sidebar expanded → collapse it. Tab state is preserved.
      rightSplit.collapse();
    } else {
      // No right sidebar (mobile? unusual layout?) — just reveal.
      await this.app.workspace.revealLeaf(leaves[0]);
    }
  }

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
    return confirmRegenerateEditedCards(
      this.app,
      this.t('displayName'),
      this.t('confirmRegenerateEditedCards'),
      this.t('confirmRegenerateCancel'),
      this.t('confirmRegenerateProceed'),
    );
  }

  addFileMenuItems(menu: ObsidianMenu, file: unknown) {
    if (!(file instanceof TFile) || !file.path.endsWith('.md')) return;
    menu.addSeparator();
    menu.addItem((it: ObsidianMenuItem) =>
      it
        .setTitle(this.t('fileMenuGenerate'))
        .setIcon('book-open')
        .onClick(() => void this.runForFile(file, false)),
    );
    menu.addItem((it: ObsidianMenuItem) =>
      it
        .setTitle(this.t('fileMenuRegen'))
        .setIcon('refresh-cw')
        .onClick(() => void this.runForFile(file, true)),
    );
    if (this.cacheManager.get(file.path)) {
      menu.addItem((it: ObsidianMenuItem) =>
        it
          .setTitle(this.t('fileMenuClear'))
          .setIcon('trash')
          .onClick(async () => {
            await this.cacheManager.delete(file.path);
            this.refreshViewAfterCacheDelete(file.path);
            new Notice(this.t('cacheClearedFile', { name: file.basename }));
          }),
      );
    }
  }

  private refreshViewAfterCacheDelete(filePath: string) {
    const view = this.getParallelView();
    if (view?.sourceFile?.path === filePath) view.renderEmpty();
  }

  private refreshViewAfterCacheClear() {
    const view = this.getParallelView();
    if (view) view.renderEmpty();
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
      (key, vars) => this.t(key, vars),
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

  async runForFile(
    file: TFile | null,
    force: boolean,
    options: RunForFileOptions = {},
    preloadedContent?: string,
  ): Promise<RunForFileResult> {
    if (!file) {
      new Notice(this.t('openNoteFirst'));
      return 'error';
    }
    if (this.jobs.isPending(file.path)) {
      new Notice(this.t('alreadyGenerating'));
      return 'already-running';
    }
    if (
      !options.skipEditConfirm &&
      shouldConfirmRegenerate(this.cacheManager.get(file.path), force) &&
      !(await this.confirmRegenerateEditedCards())
    ) {
      new Notice(this.t('regenerateCancelled'));
      return 'cancelled';
    }

    let view: ParallelReaderView | null = null;
    let outcome: RunForFileResult = 'error';

    await this.jobs
      .start(file.path, async (job) => {
        job.setPhase('reading');
        const content = preloadedContent ?? (await this.app.vault.read(file));
        job.throwIfCancelled();
        if (!content.trim()) {
          new Notice(this.t('emptyNote'));
          outcome = 'empty';
          return;
        }

        if (options.silentView) {
          view = this.getParallelView() ?? null;
        } else {
          view = await this.ensureView();
          if (!view) {
            outcome = 'no-view';
            return;
          }
        }
        job.throwIfCancelled();

        // In non-silent mode the user explicitly asked to generate THIS file —
        // bind the view to it (so subsequent viewIsShowingFile guards pass and
        // streaming/loadFor render correctly even if the panel was previously
        // showing a different note).
        const shouldRender = !options.silentView || this.viewIsShowingFile(view, file);

        job.setPhase('cache-check');
        if (!force) {
          const entry = this.cacheManager.get(file.path);
          if (entry && cacheEntryMatches(entry, content, this.settings)) {
            this.cacheTouch(file.path);
            if (view && shouldRender && this.activeFileStillMatches(file)) {
              view.loadFor(file, resolveCardAnchors(content, entry.cards), false);
              this.syncActiveFromFile(file);
            }
            outcome = 'cached';
            return;
          }
        }

        if (view && shouldRender) view.renderLoading(file, this.t('loadingGenerating'));
        const maxDocChars = Number(this.settings.maxDocChars) || DEFAULT_SETTINGS.maxDocChars;
        if (content.length > maxDocChars) new Notice(this.t('longNoteTruncated', { count: maxDocChars }));
        new Notice(this.t('generatingNotice'));

        job.setPhase('generating');
        const sections = await summarizeDocument(content, this.settings, job, this.streamProgressFor(view, file));
        job.throwIfCancelled();
        if (sections.length === 0) {
          if (view && shouldRender) view.renderError(file, this.t('noCardsReturned'));
          new Notice(this.t('noCardsReturned'));
          outcome = 'empty';
          return;
        }
        const rawCards = sections.map((s) => ({ title: s.title, anchor: s.anchor, gist: s.gist, bullets: s.bullets }));
        job.setPhase('saving');
        // Check BEFORE persisting: a job cancelled during the generate→disk window must not
        // poison the cache (a later force=false run would otherwise serve the cancelled output).
        job.throwIfCancelled();
        await this.cacheManager.put(file.path, content, rawCards, this.settings);
        job.throwIfCancelled();
        if (view && shouldRender) {
          view.loadFor(file, sections, false);
          this.syncActiveFromFile(file);
        }
        const unanchored = sections.filter((s) => s.startLine < 0).length;
        new Notice(
          this.t('generationDone', {
            count: sections.length,
            suffix: unanchored ? this.t('unanchoredSuffix', { count: unanchored }) : '',
          }),
        );
        outcome = 'generated';
      })
      .catch((e: unknown) => {
        this.handleGenerationError(e, file, view, force);
        if (e instanceof GenerationJobAlreadyRunningError) outcome = 'already-running';
        else if (e instanceof GenerationJobCancelledError) outcome = 'cancelled';
        else outcome = 'error';
        if (options.rethrowErrors) throw e;
      });

    return outcome;
  }

  private streamProgressFor(
    view: ParallelReaderView | null,
    file: TFile,
  ): ((progress: StreamProgress) => void) | undefined {
    if (!view) return undefined;
    return (progress: StreamProgress) => {
      if (!progress.done && this.viewIsShowingFile(view, file)) {
        view.renderStreamingPreview(file, progress.accumulated);
      }
    };
  }

  private handleGenerationError(e: unknown, file: TFile, view: ParallelReaderView | null, force = false) {
    if (e instanceof GenerationJobAlreadyRunningError) {
      new Notice(this.t('generationAlreadyRunning'));
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
    showGenerationError(
      {
        app: this.app,
        settings: this.settings,
        openSettings: () => this.openSettings(),
        onRetry: () => void this.runForFile(file, force),
      },
      kind,
      e,
      msg,
    );
  }

  openSettings(): void {
    // Obsidian doesn't expose a typed API for opening a specific plugin tab; use the documented
    // (but technically internal) setting/openTabById path with safe fallbacks.
    const setting = (this.app as unknown as { setting?: { open: () => void; openTabById: (id: string) => void } })
      .setting;
    if (!setting) return;
    try {
      setting.open();
      setting.openTabById(this.manifest.id);
    } catch (err: unknown) {
      console.warn('[parallel-reader] failed to open settings tab', err);
    }
  }

  /**
   * True when the active backend has a usable credential: an API key (direct or via
   * env var) for API backends, or any keyless/local provider (auth type 'none').
   * CLI backends authenticate out-of-band (claude/codex login), so they are treated
   * as configured. Used to show a first-run setup nudge instead of a dead-end.
   */
  isCredentialConfigured(): boolean {
    if (!isApiBackend(this.settings.backend)) return true;
    try {
      if (getApiAuthType(this.settings) === 'none') return true;
      return !!getApiKey(this.settings);
    } catch {
      // Settings resolution can throw for half-configured custom providers — treat as not configured.
      return false;
    }
  }

  async runBatchForFolder() {
    if (this.activeBatch) {
      new Notice(this.t('batchAlreadyRunning'));
      return;
    }
    const folderPath = await promptForBatchFolder(
      this.app,
      this.t('batchSelectFolder'),
      this.t('batchFolderPrompt'),
      this.t('batchFolderConfirm'),
      this.t('batchFolderCancel'),
    );
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
          const result = await this.runForFile(
            file,
            false,
            { rethrowErrors: true, silentView: true, skipEditConfirm: true },
            content,
          );
          if (batch.cancelled) break;
          if (result === 'generated') stats = recordBatchProcessed(stats);
          else if (result === 'cached' || result === 'already-running') stats = recordBatchSkip(stats);
          else stats = recordBatchError(stats);
        } catch (e: unknown) {
          if (batch.cancelled && e instanceof GenerationJobCancelledError) break;
          stats = recordBatchError(stats);
          console.error('[parallel-reader] batch error for', file.path, e);
        }
      }
    } finally {
      if (batch.cancelled) this.jobs.cancelAllWaiters();
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
    // loadFor() cleared the highlight (the file changed); point it at wherever the
    // editor is already scrolled to instead of waiting for the user to scroll.
    this.syncActiveFromFile(file);
  }

  bindScrollSync() {
    // Detach the PREVIOUS binding before creating a new one. This runs on every
    // `active-leaf-change`, so without this teardown a plugin-level
    // `this.registerDomEvent(...)` would accumulate one listener (and keep this plugin
    // instance reachable from the CodeMirror scroller) per leaf change for the plugin's
    // entire lifetime.
    if (this._scrollSync) {
      this.removeChild(this._scrollSync);
      this._scrollSync = null;
    }
    const mdView = this.getActiveView();
    if (!mdView) return;
    const editor = mdView.editor;
    const cm = editor && (editor as unknown as ObsidianEditorWithCm).cm;
    // querySelector's generic (rather than an `as` cast) keeps both tsc and
    // @typescript-eslint/no-unnecessary-type-assertion satisfied: registerDomEvent
    // needs HTMLElement, but an assertion here is reported as redundant.
    const scrollDom = cm?.scrollDOM ? cm.scrollDOM : mdView.contentEl.querySelector<HTMLElement>('.cm-scroller');
    if (!scrollDom) return;
    const handler = createRafThrottledHandler(() => this.handleEditorScroll(mdView));
    // Own the listener with a dedicated child Component (not a bare `this.registerDomEvent`
    // on the plugin itself) so THIS rebind can detach only the binding it owns via
    // `removeChild`, and so unloading the plugin detaches it automatically through
    // Obsidian's normal Component-unload cascade — no dependency on onunload() remembering
    // to dispose it.
    const scrollSync = new Component();
    scrollSync.registerDomEvent(scrollDom, 'scroll', handler, { passive: true });
    scrollSync.register(() => handler.cancel());
    this._scrollSync = scrollSync;
    this.addChild(scrollSync);
    // Installing the listener is not enough: until a scroll event actually fires, the
    // panel would show no active card at all (loadFor resets activeIdx on a file
    // change). Synchronize once, immediately, so switching panes highlights the card
    // the editor is already sitting on.
    this.syncActiveFromEditor(mdView);
  }

  handleEditorScroll(mdView: MarkdownView) {
    this.syncActiveFromEditor(mdView);
  }

  /**
   * The Markdown editor showing `file`, resolved from the FILE rather than from whatever
   * happens to be focused right now.
   *
   * "What is active?" is the wrong question at post-load synchronization time.
   * `ensureView()` reveals — and therefore FOCUSES — the right-side panel, so on the
   * ribbon/open-view path the active view by then is our own `ItemView` and
   * `getActiveViewOfType(MarkdownView)` returns null: the panel loaded its cached cards
   * and highlighted none of them. Resolving from the file is stateless and cannot go
   * stale when focus moves.
   *
   * The active view is consulted only as a fallback, and only when it demonstrably shows
   * THIS file — for layouts where the file's leaf is not enumerated as a `markdown` leaf.
   */
  getMarkdownViewForFile(file: TFile | null): MarkdownView | null {
    if (!file) return null;
    const leaf = this.findLeafForFile(file);
    // findLeafForFile only ever scans `getLeavesOfType('markdown')`, so the view it
    // returns is a MarkdownView; the cast just narrows the leaf's declared `View` type.
    if (leaf) return leaf.view as MarkdownView;
    const active = this.getActiveView();
    return active?.file?.path === file.path ? active : null;
  }

  /**
   * Point the active-card highlight at the editor showing `file`.
   *
   * Used by every post-load synchronization (`syncViewToFile`, and both of
   * `runForFile`'s render points), all of which run AFTER `ensureView()` may have moved
   * focus to the panel. See `getMarkdownViewForFile` for why they must not ask for the
   * active view instead.
   */
  syncActiveFromFile(file: TFile | null) {
    this.syncActiveFromEditor(this.getMarkdownViewForFile(file));
  }

  /**
   * Point the active-card highlight at whatever the editor's viewport currently shows.
   *
   * Extracted from the scroll handler because a scroll EVENT is not the only moment the
   * highlight can be wrong: `loadFor()` resets `activeIdx` to -1 whenever the file
   * changes, so opening or switching to a note with cached cards used to leave every
   * card unhighlighted until the user physically scrolled. `bindScrollSync()` calls this
   * directly with the leaf it just bound; every other first-synchronization caller goes
   * through `syncActiveFromFile()`.
   */
  syncActiveFromEditor(mdView: MarkdownView | null) {
    if (!mdView) return;
    const view = this.getParallelView();
    if (!view || !mdView.file || view.sourceFile?.path !== mdView.file.path) return;
    // A card click just drove this scroll; let the click's own highlight stand
    // instead of letting the centered-scroll landing point reassign it (often
    // to the preceding card). See view.ts's SCROLL_SYNC_CLICK_SUPPRESS_MS.
    if (view.isScrollSyncSuppressed()) return;
    const editor = mdView.editor;
    const cm = editor && (editor as unknown as ObsidianEditorWithCm).cm;
    if (!cm?.scrollDOM) return;
    const rect = cm.scrollDOM.getBoundingClientRect();
    const topY = visibleTopProbeY(rect);
    let topLine = 0;
    try {
      const pos = cm.posAtCoords({ x: rect.left + 20, y: topY });
      if (pos != null) topLine = cm.state.doc.lineAt(pos).number - 1;
    } catch {
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
      } catch {
        /* setCursor/scrollIntoView can throw during view transitions — safe to ignore */
      }
    }
  }
}

export default ParallelReaderPlugin;
