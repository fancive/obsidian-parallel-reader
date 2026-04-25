'use strict';
import { Plugin, Notice, MarkdownView, TFile, requestUrl } from 'obsidian';
import type { PluginSettings, RawCard, ResolvedCard, CacheEntry } from './src/types';
import { findLineForAnchor } from './src/anchor';
import { serializeCacheFile, shouldConfirmRegenerate, touchCacheEntry } from './src/cache';
import { resolveCliPath, runCli, summarizeViaClaudeCode, summarizeViaCodex } from './src/cli';
import { translate } from './src/i18n';
import { cardsToMarkdown } from './src/markdown';
import { buildPrompts } from './src/prompt';
import { extractJson, normalizeCardsPayload } from './src/schema';
import { createRafThrottledHandler, visibleTopProbeY } from './src/scroll';
import {
  buildAnthropicMessagesBody,
  buildGeminiBody,
  buildOpenAiChatBody,
  buildOpenAiResponsesBody,
  summarizeViaApi,
  testApiBackend,
  tokenLimitFieldForOpenAiChat,
} from './src/providers';
import {
  GenerationJobAlreadyRunningError,
  GenerationJobCancelledError,
  GenerationJobManager,
  classifyGenerationError,
} from './src/generation-job-manager';
import { addIconButton, addTextButton, copyToClipboard } from './src/ui-helpers';
import {
  CACHE_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  DEFAULT_MAX_CACHE_ENTRIES,
  cacheEntryMatches,
  generationFingerprint,
  getApiBaseUrl,
  hashContent,
  isApiBackend,
  modelForApi,
  normalizeSettings,
  pruneCacheEntries,
} from './src/settings';
import { activeIndexAfterCardDelete, removeCardAt, updateCardAt } from './src/cards';
import { activeSectionLine, nextCardIndex } from './src/navigation';
import { folderPathsForTarget } from './src/vault';
import { ParallelReaderView, VIEW_TYPE_PARALLEL } from './src/view';
import { ParallelReaderSettingTab } from './src/settings-tab';

/* ---------- Helpers ---------- */

async function summarizeDocument(content, settings, job) {
  const { system, user } = buildPrompts(content, settings);
  let cards: RawCard[];
  switch (settings.backend) {
    case 'codex':
      cards = await summarizeViaCodex(system, user, settings, job);
      break;
    case 'api':
      cards = await summarizeViaApi(requestUrl, system, user, settings);
      break;
    case 'anthropic-api':
      cards = await summarizeViaApi(requestUrl, system, user, settings);
      break;
    case 'claude-code':
    default:
      cards = await summarizeViaClaudeCode(system, user, settings, job);
      break;
  }
  const resolved: ResolvedCard[] = cards.map(c => ({
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

function cancellationNoticeKey(settings, job) {
  if (job?.phase === 'generating' && isApiBackend(settings?.backend)) {
    return 'cancelRequestedApiInFlight';
  }
  return 'cancelRequested';
}

/* ---------- Plugin ---------- */

class ParallelReaderPlugin extends Plugin {
  settings: PluginSettings;
  cache: Record<string, CacheEntry>;
  jobs: GenerationJobManager;
  _scrollDispose: (() => void) | null;
  _settingsSaveTimer: ReturnType<typeof setTimeout> | null;
  _cacheSaveTimer: ReturnType<typeof setTimeout> | null;
  _cacheDirty: boolean;

  t(key, vars?) {
    return translate(this.settings || DEFAULT_SETTINGS, key, vars);
  }

  async onload() {
    await this.loadSettings();
    this.jobs = new GenerationJobManager();
    this._cacheSaveTimer = null;
    this._cacheDirty = false;

    this.addRibbonIcon('book-open', this.t('ribbonOpen'), async () => {
      const active = this.getActiveView();
      await this.ensureView();
      if (active?.file) await this.syncViewToFile(active.file);
    });

    this.registerView(VIEW_TYPE_PARALLEL, (leaf) => new ParallelReaderView(leaf, this));

    this.addCommand({ id: 'parallel-reader-run', name: this.t('cmdRun'), callback: () => this.runForActiveFile(false) });
    this.addCommand({ id: 'parallel-reader-regen', name: this.t('cmdRegen'), callback: () => this.runForActiveFile(true) });
    this.addCommand({
      id: 'parallel-reader-open-view', name: this.t('cmdOpenView'), callback: async () => {
        const active = this.getActiveView();
        await this.ensureView();
        if (active?.file) this.syncViewToFile(active.file);
      },
    });
    this.addCommand({ id: 'parallel-reader-export-current', name: this.t('cmdExport'), callback: () => this.exportCurrentView() });
    this.addCommand({ id: 'parallel-reader-copy-current-markdown', name: this.t('cmdCopyMarkdown'), callback: () => this.copyCurrentViewMarkdown() });
    this.addCommand({ id: 'parallel-reader-cancel-current', name: this.t('cmdCancel'), callback: () => this.cancelActiveGeneration() });
    this.addCommand({
      id: 'parallel-reader-clear-current', name: this.t('cmdClearCurrent'), callback: async () => {
        const active = this.getActiveView();
        if (!active?.file) return new Notice(this.t('noCurrentNote'));
        await this.cacheDelete(active.file.path);
        new Notice(this.t('cacheClearedFile', { name: active.file.basename }));
      },
    });
    this.addCommand({
      id: 'parallel-reader-clear-all', name: this.t('cmdClearAll'), callback: async () => {
        const n = Object.keys(this.cache).length;
        await this.cacheClear();
        new Notice(this.t('cacheClearedAll', { count: n }));
      },
    });
    this.addCommand({ id: 'parallel-reader-card-prev', name: this.t('cmdCardPrev'), hotkeys: [{ modifiers: ['Alt'], key: 'ArrowUp' }], callback: () => this.moveActiveCard(-1) });
    this.addCommand({ id: 'parallel-reader-card-next', name: this.t('cmdCardNext'), hotkeys: [{ modifiers: ['Alt'], key: 'ArrowDown' }], callback: () => this.moveActiveCard(1) });
    this.addCommand({ id: 'parallel-reader-card-jump', name: this.t('cmdCardJump'), callback: () => this.jumpActiveCard() });

    this.addSettingTab(new ParallelReaderSettingTab(this.app, this));

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.bindScrollSync()));
    this.registerEvent(this.app.workspace.on('file-open', (file) => { if (file) this.syncViewToFile(file); }));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => this.addFileMenuItems(menu, file)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.handleFileRename(file, oldPath)));
    this.registerEvent(this.app.vault.on('delete', (file) => this.handleFileDelete(file)));
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
    await this.loadCache();
  }

  async saveSettings() {
    if (this._settingsSaveTimer) { clearTimeout(this._settingsSaveTimer); this._settingsSaveTimer = null; }
    await this.saveData({ settings: this.settings });
  }

  saveSettingsDebounced(delayMs = 400) {
    if (this._settingsSaveTimer) clearTimeout(this._settingsSaveTimer);
    this._settingsSaveTimer = setTimeout(() => {
      this._settingsSaveTimer = null;
      this.saveSettings().catch(e => console.error('[parallel-reader] failed to save settings', e));
    }, delayMs);
  }

  async flushSettingsSave() {
    if (!this._settingsSaveTimer) return;
    clearTimeout(this._settingsSaveTimer); this._settingsSaveTimer = null;
    await this.saveSettings();
  }

  /* ---------- Cache persistence ---------- */

  async saveCache() {
    if (this._cacheSaveTimer) { clearTimeout(this._cacheSaveTimer); this._cacheSaveTimer = null; }
    this.pruneCache();
    await this.writeCacheFile();
    this._cacheDirty = false;
  }

  scheduleCacheSave(delayMs = 5000) {
    this._cacheDirty = true;
    if (this._cacheSaveTimer) return;
    this._cacheSaveTimer = setTimeout(() => {
      this._cacheSaveTimer = null;
      if (!this._cacheDirty) return;
      this.saveCache().catch(e => console.error('[parallel-reader] failed to save cache', e));
    }, delayMs);
  }

  async flushCacheSave() {
    if (this._cacheSaveTimer) { clearTimeout(this._cacheSaveTimer); this._cacheSaveTimer = null; }
    if (!this._cacheDirty) return;
    await this.saveCache();
  }

  cacheFilePath() {
    const configDir = this.app.vault.configDir || '.obsidian';
    const pluginId = this.manifest?.id || 'parallel-reader';
    return `${configDir}/plugins/${pluginId}/cache.json`;
  }

  async ensurePluginDataDir() {
    const adapter = this.app.vault.adapter;
    const configDir = this.app.vault.configDir || '.obsidian';
    const pluginId = this.manifest?.id || 'parallel-reader';
    const dir = `${configDir}/plugins/${pluginId}`;
    try {
      if (typeof adapter.exists === 'function' && await adapter.exists(dir)) return;
      await adapter.mkdir(dir);
    } catch (_) { /* ignore race */ }
  }

  async readCacheFile() {
    const adapter = this.app.vault.adapter;
    try {
      const raw = await adapter.read(this.cacheFilePath());
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') return parsed.entries;
    } catch (e) {
      const message = String(e?.message || e || '');
      if (!/not found|does not exist|ENOENT/i.test(message)) console.warn('[parallel-reader] failed to read cache.json', e);
    }
    return {};
  }

  async writeCacheFile() {
    await this.ensurePluginDataDir();
    await this.app.vault.adapter.write(this.cacheFilePath(), serializeCacheFile(this.cache));
  }

  async loadCache() {
    this.cache = await this.readCacheFile();
    const pruned = this.pruneCache();
    if (pruned.length > 0) await this.writeCacheFile();
  }

  pruneCache() { return pruneCacheEntries(this.cache, this.settings?.maxCacheEntries || DEFAULT_MAX_CACHE_ENTRIES); }
  async pruneCacheIfNeeded() { const removed = this.pruneCache(); if (removed.length > 0) await this.saveCache(); return removed; }
  cacheGet(filePath) { return this.cache[filePath] || null; }

  async cacheTouch(filePath) {
    const entry = touchCacheEntry(this.cache[filePath] || null);
    if (!entry) return null;
    this.scheduleCacheSave();
    return entry;
  }

  async cachePut(filePath, content, cards, settings) {
    const now = new Date().toISOString();
    this.cache[filePath] = { schemaVersion: CACHE_SCHEMA_VERSION, contentHash: hashContent(content), settingsHash: generationFingerprint(settings || this.settings), cards, generatedAt: now, lastAccessedAt: now };
    await this.saveCache();
  }

  async cacheReplaceCards(filePath, cards) {
    const entry = this.cache[filePath];
    if (!entry) return false;
    const now = new Date().toISOString();
    entry.cards = (cards || []).map(card => ({ title: card.title, anchor: card.anchor, gist: card.gist, bullets: card.bullets || [] }));
    entry.updatedAt = now;
    entry.lastAccessedAt = now;
    await this.saveCache();
    return true;
  }

  async cacheDelete(filePath) { if (this.cache[filePath]) { delete this.cache[filePath]; await this.saveCache(); } }
  async cacheClear() { this.cache = {}; await this.saveCache(); }

  /* ---------- View management ---------- */

  async ensureView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_PARALLEL)[0];
    if (!leaf) { leaf = workspace.getRightLeaf(false)!; await leaf.setViewState({ type: VIEW_TYPE_PARALLEL, active: true }); }
    workspace.revealLeaf(leaf);
    return leaf.view as ParallelReaderView;
  }

  getActiveView() { return this.app.workspace.getActiveViewOfType(MarkdownView); }
  getParallelView() { return this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL)[0]?.view as ParallelReaderView | undefined; }

  moveActiveCard(delta) {
    const view = this.getParallelView();
    if (!view || !view.sections.length) { new Notice(this.t('noActiveCard')); return -1; }
    return view.moveActiveSection(delta);
  }

  jumpActiveCard() {
    const view = this.getParallelView();
    if (!view || view.jumpToActiveSection() < 0) { new Notice(this.t('noActiveCard')); return false; }
    return true;
  }

  isGeneratingFile(file) { return !!file && !!file.path && this.jobs.isRunning(file.path); }

  cancelGenerationForFile(file) {
    if (!file || !file.path) { new Notice(this.t('noCancelableJob')); return false; }
    const job = this.jobs.get(file.path);
    const noticeKey = cancellationNoticeKey(this.settings, job);
    const cancelled = this.jobs.cancel(file.path);
    new Notice(cancelled ? this.t(noticeKey) : this.t('noCancelableJob'));
    return cancelled;
  }

  viewIsShowingFile(view, file) { return !!view && !!file && view.sourceFile?.path === file.path; }
  activeFileStillMatches(file) { const active = this.getActiveView(); return !active?.file || active.file.path === file.path; }

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

  addFileMenuItems(menu, file) {
    if (!(file instanceof TFile) || !file.path.endsWith('.md')) return;
    menu.addSeparator();
    menu.addItem(it => it.setTitle(this.t('fileMenuGenerate')).setIcon('book-open').onClick(() => this.runForFile(file, false)));
    menu.addItem(it => it.setTitle(this.t('fileMenuRegen')).setIcon('refresh-cw').onClick(() => this.runForFile(file, true)));
    if (this.cacheGet(file.path)) {
      menu.addItem(it => it.setTitle(this.t('fileMenuClear')).setIcon('trash').onClick(async () => { await this.cacheDelete(file.path); new Notice(this.t('cacheClearedFile', { name: file.basename })); }));
    }
  }

  async handleFileRename(file, oldPath) {
    if (!(file instanceof TFile) || !oldPath) return;
    const wasMarkdown = oldPath.endsWith('.md');
    const isMarkdown = file.path.endsWith('.md');
    if (!wasMarkdown && !isMarkdown) return;
    if (wasMarkdown && !isMarkdown) {
      if (this.cache[oldPath]) { delete this.cache[oldPath]; await this.saveCache(); }
      const view = this.getParallelView();
      if (view && view.sourceFile?.path === oldPath) view.renderEmpty();
      return;
    }
    if (!wasMarkdown) return;
    if (this.cache[oldPath]) { this.cache[file.path] = this.cache[oldPath]; delete this.cache[oldPath]; await this.saveCache(); }
    const view = this.getParallelView();
    if (view?.sourceFile && (view.sourceFile.path === oldPath || view.sourceFile.path === file.path)) {
      view.sourceFile = file;
      await this.syncViewToFile(file);
    }
  }

  async handleFileDelete(file) {
    if (!(file instanceof TFile)) return;
    if (this.cache[file.path]) { delete this.cache[file.path]; await this.saveCache(); }
    const view = this.getParallelView();
    if (view?.sourceFile?.path === file.path) view.renderEmpty();
  }

  async exportCurrentView() {
    const active = this.getActiveView();
    const view = await this.ensureView();
    if (!view.sourceFile || !view.sections.length) { if (active?.file) await this.syncViewToFile(active.file); }
    if (!view.sourceFile || !view.sections.length) { new Notice(this.t('noExportContent')); return; }
    await view.exportToVault();
  }

  async copyCurrentViewMarkdown() {
    const active = this.getActiveView();
    const view = await this.ensureView();
    if (!view.sourceFile || !view.sections.length) { if (active?.file) await this.syncViewToFile(active.file); }
    if (!view.sourceFile || !view.sections.length) { new Notice(this.t('noCopyContent')); return; }
    await copyToClipboard(cardsToMarkdown(`${view.sourceFile.basename} · ${this.t('displayName')}`, view.sections), this.t('copiedAllMarkdown'));
  }

  /* ---------- Generation ---------- */

  async runForActiveFile(force) {
    const mdView = this.getActiveView();
    if (!mdView || !mdView.file) { new Notice(this.t('openNoteFirst')); return; }
    return this.runForFile(mdView.file, force);
  }

  async runForFile(file, force) {
    if (!file) { new Notice(this.t('openNoteFirst')); return; }
    if (this.jobs.isRunning(file.path)) { new Notice(this.t('alreadyGenerating')); return; }
    if (shouldConfirmRegenerate(this.cacheGet(file.path), force) && !this.confirmRegenerateEditedCards()) { new Notice(this.t('regenerateCancelled')); return; }

    let view: ParallelReaderView | null = null;
    return this.jobs.start(file.path, async job => {
      job.setPhase('reading');
      const content = await this.app.vault.read(file);
      job.throwIfCancelled();
      if (!content.trim()) { new Notice(this.t('emptyNote')); return; }

      view = await this.ensureView();
      job.throwIfCancelled();

      job.setPhase('cache-check');
      if (!force) {
        const entry = this.cacheGet(file.path);
        if (cacheEntryMatches(entry, content, this.settings)) {
          await this.cacheTouch(file.path);
          if (this.activeFileStillMatches(file)) await view.loadFor(file, this.resolveCardAnchors(content, entry.cards), false);
          return;
        }
      }

      await view.renderLoading(file, this.t('loadingGenerating'));
      const maxDocChars = Number(this.settings.maxDocChars) || DEFAULT_SETTINGS.maxDocChars;
      if (content.length > maxDocChars) new Notice(this.t('longNoteTruncated', { count: maxDocChars }));
      new Notice(this.t('generatingNotice'));

      job.setPhase('generating');
      const sections = await summarizeDocument(content, this.settings, job);
      job.throwIfCancelled();
      if (sections.length === 0) { new Notice(this.t('noCardsReturned')); return; }
      const rawCards = sections.map(s => ({ title: s.title, anchor: s.anchor, gist: s.gist, bullets: s.bullets }));
      job.setPhase('saving');
      await this.cachePut(file.path, content, rawCards, this.settings);
      job.throwIfCancelled();
      if (this.viewIsShowingFile(view, file)) await view.loadFor(file, sections, false);
      const unanchored = sections.filter(s => s.startLine < 0).length;
      new Notice(this.t('generationDone', { count: sections.length, suffix: unanchored ? this.t('unanchoredSuffix', { count: unanchored }) : '' }));
    }).catch(async e => {
      if (e instanceof GenerationJobAlreadyRunningError) { new Notice(e.message); return; }
      if (e instanceof GenerationJobCancelledError) { if (view && this.viewIsShowingFile(view, file)) await view.renderError(file, this.t('cancelledError')); new Notice(this.t('cancelled')); return; }
      const kind = classifyGenerationError(e);
      console.error(e);
      if (view && this.viewIsShowingFile(view, file)) await view.renderError(file, e.message || String(e));
      new Notice(this.t('generationFailed', { kind: kind === 'unknown' ? '' : ` (${kind})`, error: e.message || e }));
    });
  }

  resolveCardAnchors(content, rawCards) {
    const resolved: ResolvedCard[] = (rawCards || []).map(c => ({
      title: c.title, level: 2, anchor: c.anchor, gist: c.gist,
      startLine: findLineForAnchor(content, c.anchor), bullets: c.bullets || [],
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

  async syncViewToFile(file) {
    if (!file || !file.path || !file.path.endsWith('.md')) return;
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL);
    if (leaves.length === 0) return;
    const view = leaves[0].view as ParallelReaderView;
    if (!view || !this.activeFileStillMatches(file)) return;
    const entry = this.cacheGet(file.path);
    if (!entry) { await view.loadFor(file, [], false); view.renderEmptyWithHint(file); return; }
    const content = await this.app.vault.read(file);
    if (!this.activeFileStillMatches(file)) return;
    const stale = !cacheEntryMatches(entry, content, this.settings);
    await this.cacheTouch(file.path);
    await view.loadFor(file, this.resolveCardAnchors(content, entry.cards), stale);
  }

  bindScrollSync() {
    if (this._scrollDispose) { this._scrollDispose(); this._scrollDispose = null; }
    const mdView = this.getActiveView();
    if (!mdView) return;
    const editor = mdView.editor;
    const cm = editor && (editor as any).cm;
    const scrollDom = cm && cm.scrollDOM ? cm.scrollDOM : mdView.contentEl.querySelector('.cm-scroller');
    if (!scrollDom) return;
    const handler = createRafThrottledHandler(() => this.handleEditorScroll(mdView));
    scrollDom.addEventListener('scroll', handler, { passive: true });
    this._scrollDispose = () => { handler.cancel(); scrollDom.removeEventListener('scroll', handler); };
  }

  handleEditorScroll(mdView) {
    const view = this.getParallelView();
    if (!view || !mdView.file || view.sourceFile?.path !== mdView.file.path) return;
    const editor = mdView.editor;
    const cm = editor && (editor as any).cm;
    if (!cm || !cm.scrollDOM) return;
    const rect = cm.scrollDOM.getBoundingClientRect();
    const topY = visibleTopProbeY(rect);
    let topLine = 0;
    try {
      const pos = cm.posAtCoords({ x: rect.left + 20, y: topY });
      if (pos != null) topLine = cm.state.doc.lineAt(pos).number - 1;
    } catch (_) { return; }
    let activeIdx = -1;
    for (let i = 0; i < view.sections.length; i++) {
      const s = view.sections[i];
      if (s.startLine < 0) continue;
      if (s.startLine <= topLine) activeIdx = i;
      else break;
    }
    view.setActiveSection(activeIdx);
  }

  findLeafForFile(file) {
    if (!file) return null;
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const v = leaf.view as any;
      if (v && v.file && v.file.path === file.path) return leaf;
    }
    return null;
  }

  async scrollEditorToLine(line, file) {
    let leaf = file ? this.findLeafForFile(file) : null;
    if (!leaf && file) { leaf = this.app.workspace.getLeaf('tab'); await leaf.openFile(file, { active: false }); }
    if (!leaf) { const active = this.getActiveView(); if (active) leaf = active.leaf; }
    if (!leaf) { new Notice(this.t('noEditor')); return; }
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    const mdView = leaf.view;
    if (!(mdView instanceof MarkdownView)) return;
    mdView.setEphemeralState({ line });
    if (mdView.editor) {
      try { mdView.editor.setCursor({ line, ch: 0 }); mdView.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true); } catch (_) { /* ignore */ }
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
};
