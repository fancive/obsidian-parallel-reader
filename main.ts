'use strict';
import { Plugin, ItemView, PluginSettingTab, Setting, Notice, MarkdownView, TFile, Menu, Modal, MarkdownRenderer, requestUrl } from 'obsidian';
import type { PluginSettings, RawCard, ResolvedCard, CardPatch, CacheEntry } from './src/types';
import { findLineForAnchor } from './src/anchor';
import { serializeCacheFile, shouldConfirmRegenerate, touchCacheEntry } from './src/cache';
import { activeIndexAfterCardDelete, removeCardAt, updateCardAt } from './src/cards';
import { resolveCliPath, runCli, summarizeViaClaudeCode, summarizeViaCodex } from './src/cli';
import { translate } from './src/i18n';
import { cardToMarkdown, cardToPlain, cardsToMarkdown } from './src/markdown';
import { activeSectionLine, nextCardIndex } from './src/navigation';
import { buildPrompts } from './src/prompt';
import { ensureVaultFolder, folderPathsForTarget, normalizeVaultPath } from './src/vault';
import {
  extractJson,
  normalizeCardsPayload,
} from './src/schema';
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
  API_AUTH_TYPES,
  API_FORMATS,
  API_PROVIDER_PRESETS,
  CACHE_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  DEFAULT_MAX_CACHE_ENTRIES,
  PROMPT_LANGUAGES,
  UI_LANGUAGES,
  applyApiProviderPreset,
  cacheEntryMatches,
  generationFingerprint,
  getApiBaseUrl,
  getApiFormat,
  getApiPreset,
  hashContent,
  isApiBackend,
  modelForApi,
  normalizeSettings,
  pruneCacheEntries,
} from './src/settings';

const VIEW_TYPE_PARALLEL = 'parallel-reader-view';

async function testBackend(settings) {
  if (settings.backend === 'codex') {
    const cmd = resolveCliPath('codex', settings.cliPath);
    const { stdout } = await runCli(cmd, ['--version'], '', 10000);
    return `codex @ ${cmd}\n${stdout.trim()}`;
  }
  if (settings.backend === 'claude-code') {
    const cmd = resolveCliPath('claude', settings.cliPath);
    const { stdout } = await runCli(cmd, ['--version'], '', 10000);
    return `claude @ ${cmd}\n${stdout.trim()}`;
  }
  if (isApiBackend(settings.backend)) {
    return testApiBackend(requestUrl, settings);
  }
  throw new Error('Unknown backend: ' + settings.backend);
}

async function summarizeDocument(content, settings, job) {
  const { system, user } = buildPrompts(content, settings);
  let cards;
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
  // Resolve each card's anchor → startLine, then sort by doc order (unanchored to tail)
  const resolved = cards.map(c => ({
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

class CardEditModal extends Modal {
  plugin: ParallelReaderPlugin;
  card: ResolvedCard;
  onSave: (patch: CardPatch) => void | Promise<void>;

  constructor(app, plugin, card, onSave) {
    super(app);
    this.plugin = plugin;
    this.card = card || {};
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: this.plugin.t('editCardTitle') });

    const titleInput = this.createLabeledInput(contentEl, this.plugin.t('editCardTitleField'), this.card.title || '');
    const gistInput = this.createLabeledTextarea(contentEl, this.plugin.t('editCardGistField'), this.card.gist || '', 3);
    const bulletsInput = this.createLabeledTextarea(contentEl, this.plugin.t('editCardBulletsField'), (this.card.bullets || []).join('\n'), 8);

    const actions = contentEl.createDiv({ cls: 'parallel-reader-modal-actions' });
    addTextButton(actions, null, this.plugin.t('editCardCancel'), () => this.close(), 'parallel-reader-text-button');
    addTextButton(actions, null, this.plugin.t('editCardSave'), async () => {
      await this.onSave({
        title: titleInput.value.trim() || this.card.title || '',
        gist: gistInput.value.trim(),
        bullets: bulletsInput.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean),
      });
      this.close();
    }, 'parallel-reader-text-button');
  }

  createLabeledInput(parent, label, value) {
    const wrapper = parent.createDiv({ cls: 'parallel-reader-modal-field' });
    wrapper.createEl('label', { text: label });
    const input = wrapper.createEl('input', { attr: { type: 'text' } });
    input.value = value;
    return input;
  }

  createLabeledTextarea(parent, label, value, rows) {
    const wrapper = parent.createDiv({ cls: 'parallel-reader-modal-field' });
    wrapper.createEl('label', { text: label });
    const textarea = wrapper.createEl('textarea');
    textarea.rows = rows;
    textarea.value = value;
    return textarea;
  }
}

/* ---------- Right-pane view ---------- */

class ParallelReaderView extends ItemView {
  plugin: ParallelReaderPlugin;
  sections: ResolvedCard[];
  sourceFile: TFile | null;
  cards: HTMLElement[];
  activeIdx: number;
  stale: boolean;
  loadingMessage: string;
  errorMessage: string;

  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.sections = []; // [{title, level, anchor, startLine, bullets}]
    this.sourceFile = null;
    this.cards = []; // DOM refs
    this.activeIdx = -1;
    this.loadingMessage = '';
    this.errorMessage = '';
  }

  getViewType() { return VIEW_TYPE_PARALLEL; }
  getDisplayText() { return this.plugin.t('displayName'); }
  getIcon() { return 'book-open'; }

  onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('parallel-reader-container');
    container.setAttr('tabindex', '0');
    container.addEventListener('keydown', e => this.handleKeydown(e as KeyboardEvent));
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

  async loadFor(file, sections, stale) {
    this.sourceFile = file;
    this.sections = sections;
    this.stale = !!stale;
    this.loadingMessage = '';
    this.errorMessage = '';
    this.render();
  }

  async renderLoading(file, message) {
    this.sourceFile = file;
    this.sections = [];
    this.stale = false;
    this.loadingMessage = message || this.plugin.t('loadingDefault');
    this.errorMessage = '';
    this.render();
  }

  async renderError(file, message) {
    this.sourceFile = file;
    this.sections = [];
    this.stale = false;
    this.loadingMessage = '';
    this.errorMessage = message || this.plugin.t('errorTitle');
    this.render();
  }

  renderEmptyWithHint(file) {
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
  }

  render() {
    const container = this.containerEl.children[1];
    container.empty();

    const header = container.createDiv({ cls: 'parallel-reader-header' });
    const headerRow = header.createDiv({ cls: 'parallel-reader-header-row' });
    headerRow.createEl('div', { text: this.sourceFile?.basename || '', cls: 'parallel-reader-title' });
    const actions = headerRow.createDiv({ cls: 'parallel-reader-actions' });
    if (this.sourceFile) {
      if (this.plugin.isGeneratingFile(this.sourceFile)) {
        addIconButton(actions, 'square', this.plugin.t('actionCancel'), () => this.plugin.cancelGenerationForFile(this.sourceFile));
      } else {
        addIconButton(actions, 'refresh-cw', this.plugin.t('actionRegenerate'), () => this.plugin.runForFile(this.sourceFile, true));
      }
      addIconButton(actions, 'copy', this.plugin.t('actionCopyAll'), () => this.plugin.copyCurrentViewMarkdown());
      addIconButton(actions, 'download', this.plugin.t('actionExport'), () => this.exportToVault());
    }

    if (this.stale) {
      const banner = container.createDiv({ cls: 'parallel-reader-stale-banner' });
      banner.createSpan({ text: this.plugin.t('staleBanner') });
      addTextButton(
        banner,
        'refresh-cw',
        this.plugin.t('actionRegenerate'),
        () => this.plugin.runForFile(this.sourceFile, true),
        'parallel-reader-stale-button'
      );
    }

    if (this.loadingMessage) {
      const state = container.createDiv({ cls: 'parallel-reader-state parallel-reader-loading' });
      state.createDiv({ cls: 'parallel-reader-spinner' });
      state.createEl('div', { text: this.loadingMessage, cls: 'parallel-reader-state-title' });
      state.createEl('div', { text: this.plugin.t('loadingSubtitle'), cls: 'parallel-reader-state-subtitle' });
      return;
    }

    if (this.errorMessage) {
      const state = container.createDiv({ cls: 'parallel-reader-state parallel-reader-error' });
      state.createEl('div', { text: this.plugin.t('errorTitle'), cls: 'parallel-reader-state-title' });
      state.createEl('div', { text: this.errorMessage, cls: 'parallel-reader-state-subtitle' });
      addTextButton(
        state,
        'refresh-cw',
        this.plugin.t('actionRegenerate'),
        () => this.plugin.runForFile(this.sourceFile, true),
        'parallel-reader-text-button'
      );
      return;
    }

    const list = container.createDiv({ cls: 'parallel-reader-cards' });
    this.cards = [];
    const sourcePath = this.sourceFile?.path || '';
    this.sections.forEach((s, i) => {
      const card = list.createDiv({ cls: 'parallel-reader-card' });
      card.dataset.idx = String(i);
      if (s.startLine < 0) card.addClass('parallel-reader-card-unanchored');

      // --- Title row ---
      const title = card.createEl('div', { cls: 'parallel-reader-card-title' });
      title.createSpan({ text: s.title });
      if (s.startLine < 0) {
        title.createEl('span', { text: ' ⚠', cls: 'parallel-reader-warn', title: this.plugin.t('anchorMismatch') });
      }

      // --- Gist (rendered as markdown so inline bold/code/links work) ---
      if (s.gist) {
        const gistEl = card.createEl('div', { cls: 'parallel-reader-gist' });
        MarkdownRenderer.render(this.app, s.gist, gistEl, sourcePath, this).catch(() => {
          gistEl.setText(s.gist);
        });
      }

      // --- Bullets (rendered as markdown list — handles tables, bold, etc.) ---
      const bs = s.bullets || [];
      if (bs.length > 0) {
        const bulletsEl = card.createEl('div', { cls: 'parallel-reader-bullets-md' });
        const md = bs.map(b => `- ${b}`).join('\n');
        MarkdownRenderer.render(this.app, md, bulletsEl, sourcePath, this).catch(() => {
          bulletsEl.setText(md);
        });
      } else if (!s.gist) {
        card.createEl('div', { cls: 'parallel-reader-empty-li', text: this.plugin.t('emptyCard') });
      }

      // Left click → jump to source line
      card.addEventListener('click', (e) => {
        // Don't hijack when user is selecting text
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
        // Let clicks on anchor links pass through (e.g. wikilinks inside rendered markdown)
        const target = e.target as HTMLElement | null;
        if (target && target.tagName === 'A') return;
        if (s.startLine >= 0) this.plugin.scrollEditorToLine(s.startLine, this.sourceFile);
      });

      // Right click → context menu with copy actions
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem(it => it.setTitle(this.plugin.t('menuCopyMarkdown')).setIcon('copy')
          .onClick(() => copyToClipboard(cardToMarkdown(s), this.plugin.t('copiedMarkdown'))));
        menu.addItem(it => it.setTitle(this.plugin.t('menuCopyPlain')).setIcon('clipboard-copy')
          .onClick(() => copyToClipboard(cardToPlain(s), this.plugin.t('copiedPlain'))));
        if (s.anchor) {
          menu.addItem(it => it.setTitle(this.plugin.t('menuCopyAnchor')).setIcon('quote-glyph')
            .onClick(() => copyToClipboard(s.anchor, this.plugin.t('copiedAnchor'))));
        }
        menu.addSeparator();
        if (s.startLine >= 0) {
          menu.addItem(it => it.setTitle(this.plugin.t('menuJumpSource')).setIcon('arrow-right')
            .onClick(() => this.plugin.scrollEditorToLine(s.startLine, this.sourceFile)));
        }
        menu.addSeparator();
        menu.addItem(it => it.setTitle(this.plugin.t('menuEditCard')).setIcon('pencil')
          .onClick(() => this.openEditCardModal(i)));
        menu.addItem(it => it.setTitle(this.plugin.t('menuDeleteCard')).setIcon('trash')
          .onClick(() => this.deleteCard(i)));
        menu.showAtMouseEvent(e);
      });

      this.cards.push(card);
    });
    if (this.activeIdx >= 0 && this.cards[this.activeIdx]) {
      this.cards[this.activeIdx].addClass('is-active');
    }
  }

  setActiveSection(idx) {
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

  moveActiveSection(delta) {
    const nextIdx = nextCardIndex(this.activeIdx, this.sections.length, delta);
    this.setActiveSection(nextIdx);
    this.focusSummaryPane();
    return nextIdx;
  }

  jumpToActiveSection() {
    const line = activeSectionLine(this.sections, this.activeIdx);
    if (line < 0 || !this.sourceFile) return -1;
    this.plugin.scrollEditorToLine(line, this.sourceFile);
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

  async deleteCard(index) {
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

  openEditCardModal(index) {
    if (!this.sourceFile || !this.sections[index]) return false;
    new CardEditModal(this.app, this.plugin, this.sections[index], patch => this.updateCard(index, patch)).open();
    return true;
  }

  async updateCard(index, patch) {
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
        await this.cacheDelete(active.file.path);
        new Notice(this.t('cacheClearedFile', { name: active.file.basename }));
      },
    });

    this.addCommand({
      id: 'parallel-reader-clear-all',
      name: this.t('cmdClearAll'),
      callback: async () => {
        const n = Object.keys(this.cache).length;
        await this.cacheClear();
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

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.bindScrollSync())
    );
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file) this.syncViewToFile(file);
      })
    );
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => this.addFileMenuItems(menu, file))
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => this.handleFileRename(file, oldPath))
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => this.handleFileDelete(file))
    );
    this.bindScrollSync();
  }

  async onunload() {
    await this.flushSettingsSave();
    await this.flushCacheSave();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_PARALLEL);
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    const settingsBlob = data.settings || {};
    this.settings = normalizeSettings(Object.assign({}, DEFAULT_SETTINGS, settingsBlob));
    await this.loadCache();
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
      this.saveSettings().catch(e => console.error('[parallel-reader] failed to save settings', e));
    }, delayMs);
  }

  async flushSettingsSave() {
    if (!this._settingsSaveTimer) return;
    clearTimeout(this._settingsSaveTimer);
    this._settingsSaveTimer = null;
    await this.saveSettings();
  }

  async saveCache() {
    if (this._cacheSaveTimer) {
      clearTimeout(this._cacheSaveTimer);
      this._cacheSaveTimer = null;
    }
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
    if (this._cacheSaveTimer) {
      clearTimeout(this._cacheSaveTimer);
      this._cacheSaveTimer = null;
    }
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
    } catch (_) {
      // The plugin directory normally already exists; ignore create races.
    }
  }

  async readCacheFile() {
    const adapter = this.app.vault.adapter;
    try {
      const raw = await adapter.read(this.cacheFilePath());
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        return parsed.entries;
      }
    } catch (e) {
      const message = String(e?.message || e || '');
      if (!/not found|does not exist|ENOENT/i.test(message)) {
        console.warn('[parallel-reader] failed to read cache.json', e);
      }
    }
    return {};
  }

  async writeCacheFile() {
    await this.ensurePluginDataDir();
    await this.app.vault.adapter.write(
      this.cacheFilePath(),
      serializeCacheFile(this.cache)
    );
  }

  async loadCache() {
    const fileCache = await this.readCacheFile();
    this.cache = fileCache;
    const pruned = this.pruneCache();
    if (pruned.length > 0) await this.writeCacheFile();
  }

  pruneCache() {
    return pruneCacheEntries(this.cache, this.settings?.maxCacheEntries || DEFAULT_MAX_CACHE_ENTRIES);
  }

  async pruneCacheIfNeeded() {
    const removed = this.pruneCache();
    if (removed.length > 0) await this.saveCache();
    return removed;
  }

  cacheGet(filePath) {
    return this.cache[filePath] || null;
  }

  async cacheTouch(filePath) {
    const entry = touchCacheEntry(this.cache[filePath] || null);
    if (!entry) return null;
    this.scheduleCacheSave();
    return entry;
  }

  async cachePut(filePath, content, cards, settings) {
    const now = new Date().toISOString();
    this.cache[filePath] = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      contentHash: hashContent(content),
      settingsHash: generationFingerprint(settings || this.settings),
      cards,
      generatedAt: now,
      lastAccessedAt: now,
    };
    await this.saveCache();
  }

  async cacheReplaceCards(filePath, cards) {
    const entry = this.cache[filePath];
    if (!entry) return false;
    const now = new Date().toISOString();
    entry.cards = (cards || []).map(card => ({
      title: card.title,
      anchor: card.anchor,
      gist: card.gist,
      bullets: card.bullets || [],
    }));
    entry.updatedAt = now;
    entry.lastAccessedAt = now;
    await this.saveCache();
    return true;
  }

  async cacheDelete(filePath) {
    if (this.cache[filePath]) {
      delete this.cache[filePath];
      await this.saveCache();
    }
  }

  async cacheClear() {
    this.cache = {};
    await this.saveCache();
  }

  async ensureView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_PARALLEL)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
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

  moveActiveCard(delta) {
    const view = this.getParallelView();
    if (!view || !view.sections.length) {
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

  isGeneratingFile(file) {
    return !!file && !!file.path && this.jobs.isRunning(file.path);
  }

  cancelGenerationForFile(file) {
    if (!file || !file.path) {
      new Notice(this.t('noCancelableJob'));
      return false;
    }
    const job = this.jobs.get(file.path);
    const noticeKey = cancellationNoticeKey(this.settings, job);
    const cancelled = this.jobs.cancel(file.path);
    new Notice(cancelled ? this.t(noticeKey) : this.t('noCancelableJob'));
    return cancelled;
  }

  viewIsShowingFile(view, file) {
    return !!view && !!file && view.sourceFile?.path === file.path;
  }

  activeFileStillMatches(file) {
    const active = this.getActiveView();
    return !active?.file || active.file.path === file.path;
  }

  cancelActiveGeneration() {
    const active = this.getActiveView();
    if (active?.file && this.cancelGenerationForFile(active.file)) return;
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL)[0]?.view as ParallelReaderView | undefined;
    if (view?.sourceFile) this.cancelGenerationForFile(view.sourceFile);
    else new Notice(this.t('noCancelableJob'));
  }

  confirmRegenerateEditedCards() {
    const message = this.t('confirmRegenerateEditedCards');
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      return window.confirm(message);
    }
    return true;
  }

  addFileMenuItems(menu, file) {
    if (!(file instanceof TFile) || !file.path.endsWith('.md')) return;
    menu.addSeparator();
    menu.addItem(it => it
      .setTitle(this.t('fileMenuGenerate'))
      .setIcon('book-open')
      .onClick(() => this.runForFile(file, false)));
    menu.addItem(it => it
      .setTitle(this.t('fileMenuRegen'))
      .setIcon('refresh-cw')
      .onClick(() => this.runForFile(file, true)));
    if (this.cacheGet(file.path)) {
      menu.addItem(it => it
        .setTitle(this.t('fileMenuClear'))
        .setIcon('trash')
        .onClick(async () => {
          await this.cacheDelete(file.path);
          new Notice(this.t('cacheClearedFile', { name: file.basename }));
        }));
    }
  }

  async handleFileRename(file, oldPath) {
    if (!(file instanceof TFile) || !oldPath) return;
    const wasMarkdown = oldPath.endsWith('.md');
    const isMarkdown = file.path.endsWith('.md');
    if (!wasMarkdown && !isMarkdown) return;
    if (wasMarkdown && !isMarkdown) {
      if (this.cache[oldPath]) {
        delete this.cache[oldPath];
        await this.saveCache();
      }
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL);
      const view = leaves[0]?.view as ParallelReaderView | undefined;
      if (view?.sourceFile?.path === oldPath) view.renderEmpty();
      return;
    }
    if (!wasMarkdown) return;
    if (this.cache[oldPath]) {
      this.cache[file.path] = this.cache[oldPath];
      delete this.cache[oldPath];
      await this.saveCache();
    }
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL);
    const view = leaves[0]?.view as ParallelReaderView | undefined;
    if (view?.sourceFile && (view.sourceFile.path === oldPath || view.sourceFile.path === file.path)) {
      view.sourceFile = file;
      await this.syncViewToFile(file);
    }
  }

  async handleFileDelete(file) {
    if (!(file instanceof TFile)) return;
    const hadCache = !!this.cache[file.path];
    if (hadCache) {
      delete this.cache[file.path];
      await this.saveCache();
    }
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL);
    const view = leaves[0]?.view as ParallelReaderView | undefined;
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
      this.t('copiedAllMarkdown')
    );
  }

  async runForActiveFile(force) {
    const mdView = this.getActiveView();
    if (!mdView || !mdView.file) {
      new Notice(this.t('openNoteFirst'));
      return;
    }
    return this.runForFile(mdView.file, force);
  }

  async runForFile(file, force) {
    if (!file) {
      new Notice(this.t('openNoteFirst'));
      return;
    }
    const runningKey = file.path;
    if (this.jobs.isRunning(runningKey)) {
      new Notice(this.t('alreadyGenerating'));
      return;
    }
    if (shouldConfirmRegenerate(this.cacheGet(file.path), force) && !this.confirmRegenerateEditedCards()) {
      new Notice(this.t('regenerateCancelled'));
      return false;
    }

    let view = null;
    return this.jobs.start(runningKey, async job => {
      job.setPhase('reading');
      const content = await this.app.vault.read(file);
      job.throwIfCancelled();
      if (!content.trim()) {
        new Notice(this.t('emptyNote'));
        return;
      }

      view = await this.ensureView();
      job.throwIfCancelled();

      // Try cache unless user explicitly forced regeneration
      job.setPhase('cache-check');
      if (!force) {
        const entry = this.cacheGet(file.path);
        if (cacheEntryMatches(entry, content, this.settings)) {
          await this.cacheTouch(file.path);
          if (this.activeFileStillMatches(file)) {
            await view.loadFor(file, this.resolveCardAnchors(content, entry.cards), false);
          }
          return;
        }
      }

      await view.renderLoading(file, this.t('loadingGenerating'));
      const maxDocChars = Number(this.settings.maxDocChars) || DEFAULT_SETTINGS.maxDocChars;
      if (content.length > maxDocChars) {
        new Notice(this.t('longNoteTruncated', { count: maxDocChars }));
      }
      new Notice(this.t('generatingNotice'));

      job.setPhase('generating');
      const sections = await summarizeDocument(content, this.settings, job);
      job.throwIfCancelled();
      if (sections.length === 0) {
        new Notice(this.t('noCardsReturned'));
        return;
      }
      // Persist raw cards (without computed startLine — re-resolve on load, in case source was renamed/edited)
      const rawCards = sections.map(s => ({
        title: s.title,
        anchor: s.anchor,
        gist: s.gist,
        bullets: s.bullets,
      }));
      job.setPhase('saving');
      await this.cachePut(file.path, content, rawCards, this.settings);
      job.throwIfCancelled();

      if (this.viewIsShowingFile(view, file)) {
        await view.loadFor(file, sections, false);
      }
      const unanchored = sections.filter(s => s.startLine < 0).length;
      new Notice(this.t('generationDone', {
        count: sections.length,
        suffix: unanchored ? this.t('unanchoredSuffix', { count: unanchored }) : '',
      }));
    }).catch(async e => {
      if (e instanceof GenerationJobAlreadyRunningError) {
        new Notice(e.message);
        return;
      }
      if (e instanceof GenerationJobCancelledError) {
        if (this.viewIsShowingFile(view, file)) await view.renderError(file, this.t('cancelledError'));
        new Notice(this.t('cancelled'));
        return;
      }
      const kind = classifyGenerationError(e);
      console.error(e);
      if (this.viewIsShowingFile(view, file)) await view.renderError(file, e.message || String(e));
      new Notice(this.t('generationFailed', {
        kind: kind === 'unknown' ? '' : ` (${kind})`,
        error: e.message || e,
      }));
    });
  }

  // Rehydrate cached cards: compute startLine from anchor against current content
  resolveCardAnchors(content, rawCards) {
    const resolved = (rawCards || []).map(c => ({
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

  async syncViewToFile(file) {
    if (!file || !file.path || !file.path.endsWith('.md')) return;
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL);
    if (leaves.length === 0) return; // view not open, nothing to sync
    const view = leaves[0].view as ParallelReaderView;
    if (!view) return;
    if (!this.activeFileStillMatches(file)) return;

    const entry = this.cacheGet(file.path);
    if (!entry) {
      // No cache for this file → clear panel
      await view.loadFor(file, [], false);
      view.renderEmptyWithHint(file);
      return;
    }

    const content = await this.app.vault.read(file);
    if (!this.activeFileStillMatches(file)) return;
    const stale = !cacheEntryMatches(entry, content, this.settings);
    await this.cacheTouch(file.path);
    const resolved = this.resolveCardAnchors(content, entry.cards);
    await view.loadFor(file, resolved, stale);
  }

  bindScrollSync() {
    // Remove previous listener reference
    if (this._scrollDispose) {
      this._scrollDispose();
      this._scrollDispose = null;
    }

    const mdView = this.getActiveView();
    if (!mdView) return;

    // Prefer CM6 scrollDOM when available
    const editor = mdView.editor;
    const cm = editor && (editor as any).cm;
    const scrollDom = cm && cm.scrollDOM ? cm.scrollDOM : mdView.contentEl.querySelector('.cm-scroller');
    if (!scrollDom) return;

    const handler = createRafThrottledHandler(() => this.handleEditorScroll(mdView));
    scrollDom.addEventListener('scroll', handler, { passive: true });
    this._scrollDispose = () => {
      handler.cancel();
      scrollDom.removeEventListener('scroll', handler);
    };
  }

  handleEditorScroll(mdView) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL);
    if (leaves.length === 0) return;
    const view = leaves[0].view as ParallelReaderView;
    if (!view || !mdView.file || view.sourceFile?.path !== mdView.file.path) return;

    const editor = mdView.editor;
    const cm = editor && (editor as any).cm;
    if (!cm) return;
    const scrollDom = cm.scrollDOM;
    if (!scrollDom) return;

    // Find visible top line
    const rect = scrollDom.getBoundingClientRect();
    const topY = visibleTopProbeY(rect);
    let topLine = 0;
    try {
      const pos = cm.posAtCoords({ x: rect.left + 20, y: topY });
      if (pos != null) {
        topLine = cm.state.doc.lineAt(pos).number - 1; // 0-indexed
      }
    } catch (e) {
      return;
    }

    // Find the closest anchored section whose startLine <= topLine
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
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const v = leaf.view as any;
      if (v && v.file && v.file.path === file.path) return leaf;
    }
    return null;
  }

  async scrollEditorToLine(line, file) {
    let leaf = file ? this.findLeafForFile(file) : null;

    // Fallback: file not open anywhere → open it in a new tab in the main area
    if (!leaf && file) {
      leaf = this.app.workspace.getLeaf('tab');
      await leaf.openFile(file, { active: false });
    }

    // Last resort: currently active markdown view
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

    // Use ephemeral state — works in both source/live-preview AND reading mode.
    mdView.setEphemeralState({ line });

    // Belt-and-suspenders: also scroll the editor if in source/live-preview mode.
    if (mdView.editor) {
      try {
        mdView.editor.setCursor({ line, ch: 0 });
        mdView.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
      } catch (_) { /* ignore */ }
    }
  }
}

/* ---------- Settings tab ---------- */

class ParallelReaderSettingTab extends PluginSettingTab {
  plugin: ParallelReaderPlugin;

  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const tr = (key, vars?) => this.plugin.t(key, vars);
    containerEl.empty();
    containerEl.createEl('h2', { text: tr('settingsTitle') });

    new Setting(containerEl)
      .setName(tr('settingUiLanguageName'))
      .setDesc(tr('settingUiLanguageDesc'))
      .addDropdown(d => {
        for (const [id, label] of Object.entries(UI_LANGUAGES)) {
          d.addOption(id, label);
        }
        return d
          .setValue(this.plugin.settings.uiLanguage || DEFAULT_SETTINGS.uiLanguage)
          .onChange(async v => {
            this.plugin.settings.uiLanguage = v;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName(tr('settingBackendName'))
      .setDesc(tr('settingBackendDesc'))
      .addDropdown(d => d
        .addOption('claude-code', 'Claude Code CLI')
        .addOption('codex', 'Codex CLI')
        .addOption('api', 'API / Provider')
        .addOption('anthropic-api', 'Anthropic API (legacy)')
        .setValue(this.plugin.settings.backend)
        .onChange(async v => {
          this.plugin.settings.backend = v;
          if (v === 'api' && !this.plugin.settings.apiBaseUrl) {
            applyApiProviderPreset(this.plugin.settings, this.plugin.settings.apiProvider || 'anthropic');
          }
          await this.plugin.saveSettings();
          this.display();
        }));

    const apiBackend = isApiBackend(this.plugin.settings.backend);

    if (!apiBackend) {
      new Setting(containerEl)
        .setName(tr('settingCliPathName'))
        .setDesc(tr('settingCliPathDesc'))
        .addText(t => t
          .setPlaceholder(tr('settingCliPathPlaceholder'))
          .setValue(this.plugin.settings.cliPath)
          .onChange(async v => {
            this.plugin.settings.cliPath = v.trim();
            this.plugin.saveSettingsDebounced();
          }));

      new Setting(containerEl)
        .setName(tr('settingCliTimeoutName'))
        .addText(t => t
          .setValue(String(this.plugin.settings.cliTimeoutMs))
          .onChange(async v => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.cliTimeoutMs = n;
              this.plugin.saveSettingsDebounced();
            }
          }));
    } else {
      containerEl.createEl('h3', { text: tr('apiProviderHeader') });

      const preset = getApiPreset(this.plugin.settings);
      new Setting(containerEl)
        .setName(tr('settingProviderPresetName'))
        .setDesc(tr('settingProviderPresetDesc'))
        .addDropdown(d => {
          for (const [id, entry] of Object.entries(API_PROVIDER_PRESETS)) {
            d.addOption(id, (entry as any).label);
          }
          return d
            .setValue(this.plugin.settings.apiProvider)
            .onChange(async v => {
              applyApiProviderPreset(this.plugin.settings, v);
              await this.plugin.saveSettings();
              this.display();
            });
        });

      new Setting(containerEl)
        .setName(tr('settingApiFormatName'))
        .setDesc(tr('settingApiFormatDesc'))
        .addDropdown(d => {
          for (const [id, entry] of Object.entries(API_FORMATS)) {
            d.addOption(id, (entry as any).label);
          }
          return d
            .setValue(getApiFormat(this.plugin.settings))
            .onChange(async v => {
              this.plugin.settings.apiFormat = v;
              await this.plugin.saveSettings();
              this.display();
            });
        });

      new Setting(containerEl)
        .setName(tr('settingBaseUrlName'))
        .setDesc(tr('settingBaseUrlDesc'))
        .addText(t => t
          .setPlaceholder(
            (this.plugin.settings.apiProvider || '').startsWith('custom-')
              ? 'https://your-provider.example/v1'
              : (preset.baseUrl || API_FORMATS[getApiFormat(this.plugin.settings)].defaultBaseUrl)
          )
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange(async v => {
            this.plugin.settings.apiBaseUrl = v.trim();
            this.plugin.saveSettingsDebounced();
          }));

      new Setting(containerEl)
        .setName(tr('settingApiKeyName'))
        .setDesc(tr('settingApiKeyDesc'))
        .addText(t => {
          t.inputEl.type = 'password';
          return t
            .setPlaceholder('sk-...')
            .setValue(this.plugin.settings.apiKey)
            .onChange(async v => {
              this.plugin.settings.apiKey = v.trim();
              this.plugin.saveSettingsDebounced();
            });
        });

      new Setting(containerEl)
        .setName(tr('settingApiKeyEnvName'))
        .setDesc(tr('settingApiKeyEnvDesc'))
        .addText(t => t
          .setPlaceholder(preset.envVar || 'OPENAI_API_KEY')
          .setValue(this.plugin.settings.apiKeyEnvVar)
          .onChange(async v => {
            this.plugin.settings.apiKeyEnvVar = v.trim();
            this.plugin.saveSettingsDebounced();
          }));

      new Setting(containerEl)
        .setName(tr('settingAuthTypeName'))
        .setDesc(tr('settingAuthTypeDesc'))
        .addDropdown(d => {
          for (const [id, label] of Object.entries(API_AUTH_TYPES)) {
            d.addOption(id, label);
          }
          return d
            .setValue(this.plugin.settings.apiAuthType || 'auto')
            .onChange(async v => {
              this.plugin.settings.apiAuthType = v;
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName(tr('settingHeadersName'))
        .setDesc(tr('settingHeadersDesc'))
        .addTextArea(t => t
          .setPlaceholder('cf-aig-authorization: Bearer ...')
          .setValue(this.plugin.settings.apiHeaders)
          .onChange(async v => {
            this.plugin.settings.apiHeaders = v;
            this.plugin.saveSettingsDebounced();
          }));

      new Setting(containerEl)
        .setName(tr('settingMaxTokensName'))
        .addText(t => t
          .setValue(String(this.plugin.settings.apiMaxTokens))
          .onChange(async v => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.apiMaxTokens = n;
              this.plugin.saveSettingsDebounced();
            }
          }));
    }

    new Setting(containerEl)
      .setName(tr('settingModelName'))
      .setDesc(apiBackend
        ? tr('settingModelDescApi')
        : tr('settingModelDescCli'))
      .addText(t => t
        .setPlaceholder(apiBackend ? (getApiPreset(this.plugin.settings).model || 'model-id') : DEFAULT_SETTINGS.model)
        .setValue(this.plugin.settings.model)
        .onChange(async v => {
          this.plugin.settings.model = v.trim() || (apiBackend ? '' : DEFAULT_SETTINGS.model);
          this.plugin.saveSettingsDebounced();
        }));

    new Setting(containerEl)
      .setName(tr('settingMaxInputName'))
      .setDesc(tr('settingMaxInputDesc'))
      .addText(t => t
        .setValue(String(this.plugin.settings.maxDocChars || DEFAULT_SETTINGS.maxDocChars))
        .onChange(async v => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n >= 1000) {
            this.plugin.settings.maxDocChars = n;
            this.plugin.saveSettingsDebounced();
          }
        }));

    containerEl.createEl('h3', { text: tr('promptHeader') });

    new Setting(containerEl)
      .setName(tr('settingPromptLanguageName'))
      .setDesc(tr('settingPromptLanguageDesc'))
      .addDropdown(d => {
        for (const [id, label] of Object.entries(PROMPT_LANGUAGES)) {
          d.addOption(id, label);
        }
        return d
          .setValue(this.plugin.settings.promptLanguage || DEFAULT_SETTINGS.promptLanguage)
          .onChange(async v => {
            this.plugin.settings.promptLanguage = v;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(tr('settingCardRangeName'))
      .setDesc(tr('settingCardRangeDesc'))
      .addText(t => t
        .setPlaceholder('min')
        .setValue(String(this.plugin.settings.minCards || DEFAULT_SETTINGS.minCards))
        .onChange(async v => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.minCards = n;
            if (this.plugin.settings.maxCards < n) this.plugin.settings.maxCards = n;
            this.plugin.saveSettingsDebounced();
          }
        }))
      .addText(t => t
        .setPlaceholder('max')
        .setValue(String(this.plugin.settings.maxCards || DEFAULT_SETTINGS.maxCards))
        .onChange(async v => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.maxCards = Math.max(n, this.plugin.settings.minCards || DEFAULT_SETTINGS.minCards);
            this.plugin.saveSettingsDebounced();
          }
        }));

    new Setting(containerEl)
      .setName(tr('settingCustomPromptName'))
      .setDesc(tr('settingCustomPromptDesc'))
      .addTextArea(t => {
        t.inputEl.rows = 8;
        return t
          .setPlaceholder(tr('settingCustomPromptPlaceholder'))
          .setValue(this.plugin.settings.customSystemPrompt || '')
          .onChange(async v => {
            this.plugin.settings.customSystemPrompt = v;
            this.plugin.saveSettingsDebounced();
          });
      });

    new Setting(containerEl)
      .setName(tr('settingTestBackendName'))
      .setDesc(apiBackend ? tr('settingTestBackendDescApi') : tr('settingTestBackendDescCli'))
      .addButton(b => b
        .setButtonText('Test')
        .onClick(async () => {
          try {
            const result = await testBackend(this.plugin.settings);
            new Notice(`✓ ${result.slice(0, 180)}`, 8000);
          } catch (e) {
            new Notice(tr('backendTestFailed', { error: e.message }), 10000);
          }
        }));

    new Setting(containerEl)
      .setName(tr('settingExportFolderName'))
      .setDesc(tr('settingExportFolderDesc'))
      .addText(t => t
        .setValue(this.plugin.settings.exportFolder)
        .onChange(async v => {
          this.plugin.settings.exportFolder = v.trim() || DEFAULT_SETTINGS.exportFolder;
          this.plugin.saveSettingsDebounced();
        }));

    containerEl.createEl('h3', { text: tr('cacheHeader') });

    new Setting(containerEl)
      .setName(tr('settingMaxCacheName'))
      .setDesc(tr('settingMaxCacheDesc'))
      .addText(t => {
        t.setValue(String(this.plugin.settings.maxCacheEntries || DEFAULT_MAX_CACHE_ENTRIES));
        const commit = async () => {
          const n = parseInt(t.getValue(), 10);
          if (Number.isFinite(n) && n > 0) {
            this.plugin.settings.maxCacheEntries = n;
            await this.plugin.saveSettings();
            const removed = await this.plugin.pruneCacheIfNeeded();
            if (removed.length > 0) new Notice(tr('cachePruned', { count: removed.length }));
            this.display();
          }
        };
        t.inputEl.addEventListener('change', commit);
        t.inputEl.addEventListener('keydown', e => {
          if (e.key === 'Enter') t.inputEl.blur();
        });
        return t;
      });

    const cacheCount = Object.keys(this.plugin.cache).length;
    new Setting(containerEl)
      .setName(tr('cachedNotesName', { count: cacheCount }))
      .setDesc(tr('cachedNotesDesc'))
      .addButton(b => b
        .setButtonText(tr('clearAllCacheButton'))
        .setWarning()
        .onClick(async () => {
          const n = Object.keys(this.plugin.cache).length;
          await this.plugin.cacheClear();
          new Notice(tr('cacheClearedAll', { count: n }));
          this.display();
        }));
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
