'use strict';

import { type App, Notice, type Plugin, PluginSettingTab, requestUrl, Setting } from 'obsidian';
import { resolveCliPath, runCli } from './cli';
import { testApiBackend } from './providers';
import {
  API_AUTH_TYPES,
  API_FORMATS,
  API_PROVIDER_PRESETS,
  applyApiProviderPreset,
  DEFAULT_MAX_CACHE_ENTRIES,
  DEFAULT_SETTINGS,
  getApiFormat,
  getApiPreset,
  normalizeCliTimeoutMs,
  normalizeStreamingTimeoutMs,
  PROMPT_LANGUAGES,
  UI_LANGUAGES,
} from './settings';
import type { PluginHost, PluginSettings } from './types';

async function testBackend(settings: PluginSettings) {
  if (settings.backend === 'claude-code') {
    const cmd = resolveCliPath('claude', settings.cliPath);
    const { stdout } = await runCli(cmd, ['--version'], '', 10000);
    return `claude @ ${cmd}\n${stdout.trim()}`;
  }
  if (settings.backend === 'codex') {
    const cmd = resolveCliPath('codex', settings.cliPath);
    const { stdout } = await runCli(cmd, ['--version'], '', 10000);
    return `codex @ ${cmd}\n${stdout.trim()}`;
  }
  return testApiBackend(requestUrl, settings);
}

export class ParallelReaderSettingTab extends PluginSettingTab {
  plugin: Plugin & PluginHost;

  constructor(app: App, plugin: Plugin & PluginHost) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private tr(key: string, vars?: Record<string, string | number>) {
    return this.plugin.t(key, vars);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName(this.tr('settingsTitle')).setHeading();

    this.renderGeneralSection(containerEl);

    const isCliBacked = this.plugin.settings.backend === 'claude-code' || this.plugin.settings.backend === 'codex';
    this.renderBackendSection(containerEl, isCliBacked);
    this.renderPromptSection(containerEl, isCliBacked);
    this.renderActionsSection(containerEl, isCliBacked);
    this.renderCacheSection(containerEl);
  }

  private renderGeneralSection(containerEl: HTMLElement) {
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
  }

  private renderBackendSection(containerEl: HTMLElement, isCliBacked: boolean) {
    if (isCliBacked) {
      this.renderCliBackendSettings(containerEl);
    } else {
      this.renderApiBackendSettings(containerEl);
    }
  }

  private renderCliBackendSettings(containerEl: HTMLElement) {
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

    new Setting(containerEl)
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

  private renderApiBackendSettings(containerEl: HTMLElement) {
    const preset = getApiPreset(this.plugin.settings);
    new Setting(containerEl).setName(this.tr('apiProviderHeader')).setHeading();

    new Setting(containerEl)
      .setName(this.tr('settingProviderPresetName'))
      .setDesc(this.tr('settingProviderPresetDesc'))
      .addDropdown((d) => {
        for (const [id, entry] of Object.entries(API_PROVIDER_PRESETS)) {
          d.addOption(id, entry.label);
        }
        return d.setValue(this.plugin.settings.apiProvider).onChange(async (v) => {
          this.plugin.settings = applyApiProviderPreset(this.plugin.settings, v);
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName(this.tr('settingApiFormatName'))
      .setDesc(this.tr('settingApiFormatDesc'))
      .addDropdown((d) => {
        for (const [id, entry] of Object.entries(API_FORMATS)) {
          d.addOption(id, entry.label);
        }
        return d.setValue(getApiFormat(this.plugin.settings)).onChange(async (v) => {
          this.plugin.settings.apiFormat = v;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName(this.tr('settingBaseUrlName'))
      .setDesc(this.tr('settingBaseUrlDesc'))
      .addText((t) =>
        t
          .setPlaceholder(
            (this.plugin.settings.apiProvider || '').startsWith('custom-')
              ? 'https://your-provider.example/v1'
              : preset.baseUrl || API_FORMATS[getApiFormat(this.plugin.settings)].defaultBaseUrl,
          )
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange((v) => {
            this.plugin.settings.apiBaseUrl = v.trim();
            this.plugin.saveSettingsDebounced();
          }),
      );

    new Setting(containerEl)
      .setName(this.tr('settingApiKeyName'))
      .setDesc(this.tr('settingApiKeyDesc'))
      .addText((t) => {
        t.inputEl.type = 'password';
        return t.setValue(this.plugin.settings.apiKey).onChange((v) => {
          this.plugin.settings.apiKey = v.trim();
          this.plugin.saveSettingsDebounced();
        });
      });

    new Setting(containerEl)
      .setName(this.tr('settingApiKeyEnvName'))
      .setDesc(this.tr('settingApiKeyEnvDesc'))
      .addText((t) =>
        t
          .setPlaceholder(preset.envVar || 'OPENAI_API_KEY')
          .setValue(this.plugin.settings.apiKeyEnvVar)
          .onChange((v) => {
            this.plugin.settings.apiKeyEnvVar = v.trim();
            this.plugin.saveSettingsDebounced();
          }),
      );

    new Setting(containerEl)
      .setName(this.tr('settingAuthTypeName'))
      .setDesc(this.tr('settingAuthTypeDesc'))
      .addDropdown((d) => {
        for (const [id, label] of Object.entries(API_AUTH_TYPES)) {
          d.addOption(id, label);
        }
        return d.setValue(this.plugin.settings.apiAuthType || 'auto').onChange(async (v) => {
          this.plugin.settings.apiAuthType = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName(this.tr('settingHeadersName'))
      .setDesc(this.tr('settingHeadersDesc'))
      .addTextArea((t) =>
        t.setValue(this.plugin.settings.apiHeaders).onChange((v) => {
          this.plugin.settings.apiHeaders = v;
          this.plugin.saveSettingsDebounced();
        }),
      );

    new Setting(containerEl).setName(this.tr('settingMaxTokensName')).addText((t) =>
      t.setValue(String(this.plugin.settings.apiMaxTokens)).onChange((v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n > 0) {
          this.plugin.settings.apiMaxTokens = n;
          this.plugin.saveSettingsDebounced();
        }
      }),
    );

    new Setting(containerEl)
      .setName(this.tr('settingStreamingName'))
      .setDesc(this.tr('settingStreamingDesc'))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.streaming ?? true).onChange(async (v) => {
          this.plugin.settings.streaming = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName(this.tr('settingStreamingTimeoutName'))
      .setDesc(this.tr('settingStreamingTimeoutDesc'))
      .addText((t) =>
        t
          .setPlaceholder(String(DEFAULT_SETTINGS.streamingTimeoutMs))
          .setValue(String(this.plugin.settings.streamingTimeoutMs || DEFAULT_SETTINGS.streamingTimeoutMs))
          .onChange((v) => {
            this.plugin.settings.streamingTimeoutMs = normalizeStreamingTimeoutMs(v);
            this.plugin.saveSettingsDebounced();
          }),
      );
  }

  private renderPromptSection(containerEl: HTMLElement, isCliBacked: boolean) {
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

    new Setting(containerEl)
      .setName(this.tr('settingMaxInputName'))
      .setDesc(this.tr('settingMaxInputDesc'))
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxDocChars || DEFAULT_SETTINGS.maxDocChars)).onChange((v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n >= 1000) {
            this.plugin.settings.maxDocChars = n;
            this.plugin.saveSettingsDebounced();
          }
        }),
      );

    new Setting(containerEl).setName(this.tr('promptHeader')).setHeading();

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
      .addText((t) =>
        t
          .setPlaceholder('Min')
          .setValue(String(this.plugin.settings.minCards || DEFAULT_SETTINGS.minCards))
          .onChange((v) => {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n > 0) {
              this.plugin.settings.minCards = n;
              if (this.plugin.settings.maxCards < n) this.plugin.settings.maxCards = n;
              this.plugin.saveSettingsDebounced();
            }
          }),
      )
      .addText((t) =>
        t
          .setPlaceholder('Max')
          .setValue(String(this.plugin.settings.maxCards || DEFAULT_SETTINGS.maxCards))
          .onChange((v) => {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n > 0) {
              this.plugin.settings.maxCards = Math.max(n, this.plugin.settings.minCards || DEFAULT_SETTINGS.minCards);
              this.plugin.saveSettingsDebounced();
            }
          }),
      );

    new Setting(containerEl)
      .setName(this.tr('settingCustomPromptName'))
      .setDesc(this.tr('settingCustomPromptDesc'))
      .addTextArea((t) => {
        t.inputEl.rows = 8;
        return t
          .setPlaceholder(this.tr('settingCustomPromptPlaceholder'))
          .setValue(this.plugin.settings.customSystemPrompt || '')
          .onChange((v) => {
            this.plugin.settings.customSystemPrompt = v;
            this.plugin.saveSettingsDebounced();
          });
      });
  }

  private renderActionsSection(containerEl: HTMLElement, isCliBacked: boolean) {
    new Setting(containerEl)
      .setName(this.tr('settingTestBackendName'))
      .setDesc(isCliBacked ? this.tr('settingTestBackendDescCli') : this.tr('settingTestBackendDescApi'))
      .addButton((b) =>
        b.setButtonText(this.tr('settingTestBackendButton')).onClick(async () => {
          try {
            const result = await testBackend(this.plugin.settings);
            new Notice(`✓ ${result.slice(0, 180)}`, 8000);
          } catch (e: unknown) {
            new Notice(this.tr('backendTestFailed', { error: e instanceof Error ? e.message : String(e) }), 10000);
          }
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
  }

  private renderCacheSection(containerEl: HTMLElement) {
    new Setting(containerEl).setName(this.tr('cacheHeader')).setHeading();

    new Setting(containerEl)
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
    new Setting(containerEl)
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
}
