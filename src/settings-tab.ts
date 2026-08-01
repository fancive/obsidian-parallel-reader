'use strict';

import { type App, Notice, type Plugin, PluginSettingTab, Setting } from 'obsidian';
import { testBackend } from './backend-test';
import {
  API_AUTH_TYPES,
  API_FORMATS,
  API_PROVIDER_PRESETS,
  applyApiProviderPreset,
  DEFAULT_MAX_CACHE_ENTRIES,
  DEFAULT_SETTINGS,
  getApiFormat,
  getApiPreset,
  normalizeCardCount,
  normalizeCliTimeoutMs,
  normalizeStreamingTimeoutMs,
  PROMPT_LANGUAGES,
  UI_LANGUAGES,
} from './settings';
import type { PluginHost, PluginSettings } from './types';

/** Detect whether the user has departed from preset defaults. If so we keep the
 * Advanced connection section open so they can find what they configured. */
function shouldOpenAdvancedConnection(settings: PluginSettings): boolean {
  if ((settings.apiProvider || '').startsWith('custom-')) return true;
  if ((settings.apiHeaders || '').trim()) return true;
  const preset = getApiPreset(settings);
  const baseUrl = (settings.apiBaseUrl || '').trim();
  if (baseUrl && preset.baseUrl && baseUrl.replace(/\/+$/, '') !== preset.baseUrl.replace(/\/+$/, '')) return true;
  if (settings.apiAuthType && settings.apiAuthType !== 'auto') return true;
  if (settings.streaming === false) return true;
  if (settings.apiMaxTokens && settings.apiMaxTokens !== DEFAULT_SETTINGS.apiMaxTokens) return true;
  if (settings.apiFormat && preset.format && settings.apiFormat !== preset.format) return true;
  return false;
}

export class ParallelReaderSettingTab extends PluginSettingTab {
  plugin: Plugin & PluginHost;

  constructor(app: App, plugin: Plugin & PluginHost) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Closing the settings modal (or switching to another tab) races the 400ms debounce
   * in `saveSettingsDebounced` against the user quitting the app or the vault unloading.
   * Commit any pending edit immediately instead of leaving it to that timer.
   */
  hide(): void {
    this.plugin
      .flushSettingsSave()
      .catch((e: unknown) => console.error('[parallel-reader] flush settings on settings-tab hide', e));
    // Chain up: SettingTab.hide() unloads the components registered by display().
    // Overriding without calling it leaks them for the lifetime of the app.
    super.hide();
  }

  private tr(key: string, vars?: Record<string, string | number>) {
    return this.plugin.t(key, vars);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('parallel-reader-settings');

    const isCliBacked = this.plugin.settings.backend === 'claude-code' || this.plugin.settings.backend === 'codex';

    this.renderQuickSetup(containerEl, isCliBacked);
    this.renderReadingOutput(containerEl);

    if (!isCliBacked) {
      this.renderAdvancedConnection(containerEl);
    } else {
      this.renderAdvancedConnectionCli(containerEl);
    }

    this.renderAdvancedPrompt(containerEl);
    this.renderCacheMaintenance(containerEl);
  }

  /* ---------- 1. Quick setup (always expanded) ---------- */

  private renderQuickSetup(containerEl: HTMLElement, isCliBacked: boolean) {
    new Setting(containerEl).setName(this.tr('sectionQuickSetup')).setHeading();

    new Setting(containerEl)
      .setName(this.tr('settingBackendName'))
      .setDesc(this.tr('settingBackendDesc'))
      .addDropdown((d) =>
        d
          .addOption('api', 'API / provider')
          .addOption('claude-code', 'Claude code CLI')
          .addOption('codex', 'Codex CLI')
          .setValue(this.plugin.settings.backend)
          .onChange(async (v) => {
            this.plugin.settings.backend = v;
            if (v === 'api' && !this.plugin.settings.apiBaseUrl) {
              this.plugin.settings = applyApiProviderPreset(
                this.plugin.settings,
                this.plugin.settings.apiProvider || 'anthropic',
              );
            }
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (isCliBacked) {
      new Setting(containerEl)
        .setName(this.tr('settingCliPathName'))
        .setDesc(this.tr('settingCliPathDesc'))
        .addText((t) =>
          t
            .setPlaceholder(this.tr('settingCliPathPlaceholder'))
            .setValue(this.plugin.settings.cliPath)
            .onChange((v) => {
              this.plugin.settings.cliPath = v.trim();
              this.plugin.saveSettingsDebounced();
            }),
        );
    } else {
      this.renderProviderPresetWithSummary(containerEl);
      this.renderCredentialRow(containerEl);
    }

    this.renderModelRow(containerEl, isCliBacked);
    this.renderTestButton(containerEl, isCliBacked);
  }

  private renderProviderPresetWithSummary(containerEl: HTMLElement) {
    const settings = this.plugin.settings;
    const preset = getApiPreset(settings);
    const format = getApiFormat(settings);
    const baseUrl = (settings.apiBaseUrl || preset.baseUrl || API_FORMATS[format]?.defaultBaseUrl || '').replace(
      /\/+$/,
      '',
    );

    const setting = new Setting(containerEl)
      .setName(this.tr('settingProviderPresetName'))
      .setDesc(this.tr('settingProviderPresetDesc'))
      .addDropdown((d) => {
        for (const [id, entry] of Object.entries(API_PROVIDER_PRESETS)) {
          d.addOption(id, entry.label);
        }
        return d.setValue(settings.apiProvider).onChange(async (v) => {
          this.plugin.settings = applyApiProviderPreset(this.plugin.settings, v);
          await this.plugin.saveSettings();
          this.display();
        });
      });

    // Read-only summary of derived format + baseUrl, replacing the standalone rows.
    const summary = setting.descEl.createDiv({ cls: 'parallel-reader-preset-summary' });
    summary.createEl('code', {
      text: `${API_FORMATS[format]?.label || format} · ${baseUrl || this.tr('settingProviderPresetSummaryEmpty')}`,
    });
  }

  private renderCredentialRow(containerEl: HTMLElement) {
    const settings = this.plugin.settings;
    const preset = getApiPreset(settings);
    const setting = new Setting(containerEl)
      .setName(this.tr('settingApiKeyName'))
      .setDesc(this.tr('settingApiKeyDesc'));

    setting.addText((t) => {
      t.inputEl.type = 'password';
      t.inputEl.autocomplete = 'off';
      return t.setValue(settings.apiKey).onChange((v) => {
        this.plugin.settings.apiKey = v.trim();
        this.plugin.saveSettingsDebounced();
      });
    });

    // Env-var fallback: render manually (without `new Setting`) to avoid
    // nesting Obsidian .setting-item inside another controlEl, which causes
    // theme CSS conflicts (extra borders/padding from `.setting-item:first-child`).
    const envWrap = setting.controlEl.createDiv({ cls: 'parallel-reader-env-wrap' });
    const envDetails = envWrap.createEl('details');
    envDetails.createEl('summary', { text: this.tr('settingApiKeyEnvSummary') });
    const row = envDetails.createDiv({ cls: 'parallel-reader-env-row' });
    row.createEl('label', {
      text: this.tr('settingApiKeyEnvName'),
      cls: 'parallel-reader-env-label',
    });
    const envInput = row.createEl('input', {
      type: 'text',
      cls: 'parallel-reader-env-input',
    });
    envInput.placeholder = preset.envVar || 'OPENAI_API_KEY';
    envInput.value = settings.apiKeyEnvVar || '';
    envInput.addEventListener('input', () => {
      this.plugin.settings.apiKeyEnvVar = envInput.value.trim();
      this.plugin.saveSettingsDebounced();
    });
    envDetails.createDiv({
      text: this.tr('settingApiKeyEnvDesc'),
      cls: 'parallel-reader-env-desc',
    });
  }

  private renderModelRow(containerEl: HTMLElement, isCliBacked: boolean) {
    new Setting(containerEl)
      .setName(this.tr('settingModelName'))
      .setDesc(isCliBacked ? this.tr('settingModelDescCli') : this.tr('settingModelDescApi'))
      .addText((t) =>
        t
          .setPlaceholder(isCliBacked ? DEFAULT_SETTINGS.model : getApiPreset(this.plugin.settings).model || 'Model-id')
          .setValue(this.plugin.settings.model)
          .onChange((v) => {
            this.plugin.settings.model = v.trim() || (isCliBacked ? DEFAULT_SETTINGS.model : '');
            this.plugin.saveSettingsDebounced();
          }),
      );
  }

  private renderTestButton(containerEl: HTMLElement, isCliBacked: boolean) {
    new Setting(containerEl)
      .setName(this.tr('settingTestBackendName'))
      .setDesc(isCliBacked ? this.tr('settingTestBackendDescCli') : this.tr('settingTestBackendDescApi'))
      .addButton((b) =>
        b.setButtonText(this.tr('settingTestBackendButton')).onClick(async () => {
          b.setDisabled(true);
          b.setButtonText(this.tr('settingTestBackendButtonRunning'));
          try {
            const result = await testBackend(this.plugin.settings);
            new Notice(`✓ ${result.slice(0, 180)}`, 8000);
          } catch (e: unknown) {
            new Notice(this.tr('backendTestFailed', { error: e instanceof Error ? e.message : String(e) }), 10000);
          } finally {
            b.setButtonText(this.tr('settingTestBackendButton'));
            b.setDisabled(false);
          }
        }),
      );
  }

  /* ---------- 2. Reading output (always expanded) ---------- */

  private renderReadingOutput(containerEl: HTMLElement) {
    new Setting(containerEl).setName(this.tr('sectionReadingOutput')).setHeading();

    new Setting(containerEl)
      .setName(this.tr('settingPromptLanguageName'))
      .setDesc(this.tr('settingPromptLanguageDesc'))
      .addDropdown((d) => {
        for (const [id, label] of Object.entries(PROMPT_LANGUAGES)) {
          d.addOption(id, label);
        }
        return d
          .setValue(this.plugin.settings.promptLanguage || DEFAULT_SETTINGS.promptLanguage)
          .onChange(async (v) => {
            this.plugin.settings.promptLanguage = v;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(this.tr('settingCardRangeName'))
      .setDesc(this.tr('settingCardRangeDesc'))
      .addText((textComponent) =>
        textComponent
          .setPlaceholder('Min')
          .setValue(String(this.plugin.settings.minCards || DEFAULT_SETTINGS.minCards))
          .onChange((v) => {
            const trimmed = v.trim();
            if (trimmed === '') return;
            const normalized = normalizeCardCount(trimmed, DEFAULT_SETTINGS.minCards);
            this.plugin.settings.minCards = normalized;
            if (this.plugin.settings.maxCards < normalized) this.plugin.settings.maxCards = normalized;
            if (String(normalized) !== trimmed) textComponent.setValue(String(normalized));
            this.plugin.saveSettingsDebounced();
          }),
      )
      .addText((textComponent) =>
        textComponent
          .setPlaceholder('Max')
          .setValue(String(this.plugin.settings.maxCards || DEFAULT_SETTINGS.maxCards))
          .onChange((v) => {
            const trimmed = v.trim();
            if (trimmed === '') return;
            const normalized = normalizeCardCount(trimmed, DEFAULT_SETTINGS.maxCards);
            this.plugin.settings.maxCards = Math.max(
              normalized,
              this.plugin.settings.minCards || DEFAULT_SETTINGS.minCards,
            );
            if (String(this.plugin.settings.maxCards) !== trimmed) {
              textComponent.setValue(String(this.plugin.settings.maxCards));
            }
            this.plugin.saveSettingsDebounced();
          }),
      );

    new Setting(containerEl)
      .setName(this.tr('settingExportFolderName'))
      .setDesc(this.tr('settingExportFolderDesc'))
      .addText((t) =>
        t.setValue(this.plugin.settings.exportFolder).onChange((v) => {
          this.plugin.settings.exportFolder = v.trim() || DEFAULT_SETTINGS.exportFolder;
          this.plugin.saveSettingsDebounced();
        }),
      );

    new Setting(containerEl)
      .setName(this.tr('settingUiLanguageName'))
      .setDesc(this.tr('settingUiLanguageDesc'))
      .addDropdown((d) => {
        for (const [id, label] of Object.entries(UI_LANGUAGES)) {
          d.addOption(id, label);
        }
        return d.setValue(this.plugin.settings.uiLanguage || DEFAULT_SETTINGS.uiLanguage).onChange(async (v) => {
          this.plugin.settings.uiLanguage = v;
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }

  /* ---------- 3. Advanced connection (collapsed by default) ---------- */

  private renderAdvancedConnection(containerEl: HTMLElement) {
    const settings = this.plugin.settings;
    const details = this.openCollapsibleSection(
      containerEl,
      'sectionAdvancedConnection',
      shouldOpenAdvancedConnection(settings),
    );

    new Setting(details)
      .setName(this.tr('settingApiFormatName'))
      .setDesc(this.tr('settingApiFormatDesc'))
      .addDropdown((d) => {
        for (const [id, entry] of Object.entries(API_FORMATS)) {
          d.addOption(id, entry.label);
        }
        return d.setValue(getApiFormat(settings)).onChange(async (v) => {
          this.plugin.settings.apiFormat = v;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(details)
      .setName(this.tr('settingBaseUrlName'))
      .setDesc(this.tr('settingBaseUrlDesc'))
      .addText((t) => {
        const preset = getApiPreset(settings);
        t.setPlaceholder(
          (settings.apiProvider || '').startsWith('custom-')
            ? 'https://your-provider.example/v1'
            : preset.baseUrl || API_FORMATS[getApiFormat(settings)].defaultBaseUrl,
        )
          .setValue(settings.apiBaseUrl)
          .onChange((v) => {
            this.plugin.settings.apiBaseUrl = v.trim();
            this.plugin.saveSettingsDebounced();
          });
      });

    new Setting(details)
      .setName(this.tr('settingAuthTypeName'))
      .setDesc(this.tr('settingAuthTypeDesc'))
      .addDropdown((d) => {
        for (const [id, label] of Object.entries(API_AUTH_TYPES)) {
          d.addOption(id, label);
        }
        return d.setValue(settings.apiAuthType || 'auto').onChange(async (v) => {
          this.plugin.settings.apiAuthType = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(details)
      .setName(this.tr('settingHeadersName'))
      .setDesc(this.tr('settingHeadersDesc'))
      .addTextArea((t) =>
        t.setValue(settings.apiHeaders).onChange((v) => {
          this.plugin.settings.apiHeaders = v;
          this.plugin.saveSettingsDebounced();
        }),
      );

    new Setting(details).setName(this.tr('settingMaxTokensName')).addText((t) =>
      t.setValue(String(settings.apiMaxTokens)).onChange((v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n > 0) {
          this.plugin.settings.apiMaxTokens = n;
          this.plugin.saveSettingsDebounced();
        }
      }),
    );

    // Streaming + timeout merged. We build the timeout in a dedicated wrapper
    // and toggle that wrapper's visibility so we never accidentally hide the
    // shared controlEl (which would also hide the toggle itself). The row's
    // description covers both the toggle (settingStreamingDesc) and the inline
    // timeout input (settingStreamingTimeoutDesc) -- a second `new Setting` for
    // the timeout alone would nest an Obsidian `.setting-item` inside this one's
    // controlEl, which is the exact CSS-conflict pattern the env-var fallback
    // in renderCredentialRow() deliberately avoids.
    const streamingSetting = new Setting(details).setName(this.tr('settingStreamingName')).setDesc(
      createFragment((frag) => {
        frag.appendText(this.tr('settingStreamingDesc'));
        frag.createEl('br');
        frag.appendText(this.tr('settingStreamingTimeoutDesc'));
      }),
    );

    let timeoutWrap: HTMLElement | null = null;

    streamingSetting.addToggle((toggle) =>
      toggle.setValue(settings.streaming ?? true).onChange(async (v) => {
        this.plugin.settings.streaming = v;
        await this.plugin.saveSettings();
        if (timeoutWrap) timeoutWrap.toggleClass('parallel-reader-hidden', !v);
      }),
    );

    timeoutWrap = streamingSetting.controlEl.createDiv({ cls: 'parallel-reader-timeout-wrap' });
    const timeoutInput = timeoutWrap.createEl('input', {
      type: 'text',
      cls: 'parallel-reader-timeout-input',
    });
    timeoutInput.placeholder = String(DEFAULT_SETTINGS.streamingTimeoutMs);
    timeoutInput.title = this.tr('settingStreamingTimeoutName');
    timeoutInput.value = String(settings.streamingTimeoutMs || DEFAULT_SETTINGS.streamingTimeoutMs);
    timeoutInput.addEventListener('input', () => {
      this.plugin.settings.streamingTimeoutMs = normalizeStreamingTimeoutMs(timeoutInput.value);
      this.plugin.saveSettingsDebounced();
    });
    timeoutWrap.toggleClass('parallel-reader-hidden', !(settings.streaming ?? true));
  }

  private renderAdvancedConnectionCli(containerEl: HTMLElement) {
    const settings = this.plugin.settings;
    const userChangedTimeout = !!(settings.cliTimeoutMs && settings.cliTimeoutMs !== DEFAULT_SETTINGS.cliTimeoutMs);
    const details = this.openCollapsibleSection(containerEl, 'sectionAdvancedConnection', userChangedTimeout);
    new Setting(details)
      .setName(this.tr('settingCliTimeoutName'))
      .setDesc(this.tr('settingCliTimeoutDesc'))
      .addText((t) =>
        t
          .setPlaceholder(String(DEFAULT_SETTINGS.cliTimeoutMs))
          .setValue(String(this.plugin.settings.cliTimeoutMs || DEFAULT_SETTINGS.cliTimeoutMs))
          .onChange((v) => {
            this.plugin.settings.cliTimeoutMs = normalizeCliTimeoutMs(v);
            this.plugin.saveSettingsDebounced();
          }),
      );
  }

  /* ---------- 4. Advanced prompt (collapsed by default) ---------- */

  private renderAdvancedPrompt(containerEl: HTMLElement) {
    const settings = this.plugin.settings;
    const userHasCustomPrompt = !!(settings.customSystemPrompt || '').trim();
    const userHasCustomMaxInput = settings.maxDocChars && settings.maxDocChars !== DEFAULT_SETTINGS.maxDocChars;
    const details = this.openCollapsibleSection(
      containerEl,
      'sectionAdvancedPrompt',
      !!(userHasCustomPrompt || userHasCustomMaxInput),
    );

    new Setting(details)
      .setName(this.tr('settingMaxInputName'))
      .setDesc(this.tr('settingMaxInputDesc'))
      .addText((t) =>
        t.setValue(String(settings.maxDocChars || DEFAULT_SETTINGS.maxDocChars)).onChange((v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n >= 1000) {
            this.plugin.settings.maxDocChars = n;
            this.plugin.saveSettingsDebounced();
          }
        }),
      );

    new Setting(details)
      .setName(this.tr('settingCustomPromptName'))
      .setDesc(this.tr('settingCustomPromptDesc'))
      .addTextArea((t) => {
        t.inputEl.rows = 8;
        return t
          .setPlaceholder(this.tr('settingCustomPromptPlaceholder'))
          .setValue(settings.customSystemPrompt || '')
          .onChange((v) => {
            this.plugin.settings.customSystemPrompt = v;
            this.plugin.saveSettingsDebounced();
          });
      });
  }

  /* ---------- 5. Cache & maintenance (collapsed by default) ---------- */

  private renderCacheMaintenance(containerEl: HTMLElement) {
    const details = this.openCollapsibleSection(containerEl, 'sectionCacheMaintenance', false);

    new Setting(details)
      .setName(this.tr('settingMaxCacheName'))
      .setDesc(this.tr('settingMaxCacheDesc'))
      .addText((t) => {
        t.setValue(String(this.plugin.settings.maxCacheEntries || DEFAULT_MAX_CACHE_ENTRIES));
        const commit = async () => {
          const n = parseInt(t.getValue(), 10);
          if (Number.isFinite(n) && n > 0) {
            this.plugin.settings.maxCacheEntries = n;
            await this.plugin.saveSettings();
            const removed = await this.plugin.pruneCacheIfNeeded();
            if (removed.length > 0) new Notice(this.tr('cachePruned', { count: removed.length }));
            this.display();
          }
        };
        t.inputEl.addEventListener('change', () => {
          commit().catch((e: unknown) => console.error('[parallel-reader] failed to save cache settings', e));
        });
        t.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') t.inputEl.blur();
        });
        return t;
      });

    const cacheCount = Object.keys(this.plugin.cache).length;
    new Setting(details)
      .setName(this.tr('cachedNotesName', { count: cacheCount }))
      .setDesc(this.tr('cachedNotesDesc'))
      .addButton((b) =>
        b
          .setButtonText(this.tr('clearAllCacheButton'))
          .setWarning()
          .onClick(async () => {
            const n = Object.keys(this.plugin.cache).length;
            await this.plugin.cacheClear();
            new Notice(this.tr('cacheClearedAll', { count: n }));
            this.display();
          }),
      );
  }

  /* ---------- helpers ---------- */

  /** Create a `<details>` collapsible section with translated `<summary>` and
   * return the inner element to render Settings into. */
  private openCollapsibleSection(parent: HTMLElement, summaryKey: string, openByDefault: boolean): HTMLElement {
    const details = parent.createEl('details', { cls: 'parallel-reader-section' });
    if (openByDefault) details.setAttr('open', '');
    details.createEl('summary', { text: this.tr(summaryKey), cls: 'parallel-reader-section-summary' });
    return details;
  }
}
