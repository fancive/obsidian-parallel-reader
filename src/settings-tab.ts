'use strict';

import { type App, Notice, type Plugin, PluginSettingTab, requestUrl, Setting } from 'obsidian';
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
  PROMPT_LANGUAGES,
  UI_LANGUAGES,
} from './settings';
import type { PluginHost, PluginSettings } from './types';

async function testBackend(settings: PluginSettings) {
  return testApiBackend(requestUrl, settings);
}

export class ParallelReaderSettingTab extends PluginSettingTab {
  plugin: Plugin & PluginHost;

  constructor(app: App, plugin: Plugin & PluginHost) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const tr = (key: string, vars?: Record<string, string | number>) => this.plugin.t(key, vars);
    containerEl.empty();
    containerEl.createEl('h2', { text: tr('settingsTitle') });

    new Setting(containerEl)
      .setName(tr('settingUiLanguageName'))
      .setDesc(tr('settingUiLanguageDesc'))
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

    containerEl.createEl('h3', { text: tr('apiProviderHeader') });

    {
      const preset = getApiPreset(this.plugin.settings);
      new Setting(containerEl)
        .setName(tr('settingProviderPresetName'))
        .setDesc(tr('settingProviderPresetDesc'))
        .addDropdown((d) => {
          for (const [id, entry] of Object.entries(API_PROVIDER_PRESETS)) {
            d.addOption(id, entry.label);
          }
          return d.setValue(this.plugin.settings.apiProvider).onChange(async (v) => {
            applyApiProviderPreset(this.plugin.settings, v);
            await this.plugin.saveSettings();
            this.display();
          });
        });

      new Setting(containerEl)
        .setName(tr('settingApiFormatName'))
        .setDesc(tr('settingApiFormatDesc'))
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
        .setName(tr('settingBaseUrlName'))
        .setDesc(tr('settingBaseUrlDesc'))
        .addText((t) =>
          t
            .setPlaceholder(
              (this.plugin.settings.apiProvider || '').startsWith('custom-')
                ? 'https://your-provider.example/v1'
                : preset.baseUrl || API_FORMATS[getApiFormat(this.plugin.settings)].defaultBaseUrl,
            )
            .setValue(this.plugin.settings.apiBaseUrl)
            .onChange(async (v) => {
              this.plugin.settings.apiBaseUrl = v.trim();
              this.plugin.saveSettingsDebounced();
            }),
        );

      new Setting(containerEl)
        .setName(tr('settingApiKeyName'))
        .setDesc(tr('settingApiKeyDesc'))
        .addText((t) => {
          t.inputEl.type = 'password';
          return t
            .setPlaceholder('sk-...')
            .setValue(this.plugin.settings.apiKey)
            .onChange(async (v) => {
              this.plugin.settings.apiKey = v.trim();
              this.plugin.saveSettingsDebounced();
            });
        });

      new Setting(containerEl)
        .setName(tr('settingApiKeyEnvName'))
        .setDesc(tr('settingApiKeyEnvDesc'))
        .addText((t) =>
          t
            .setPlaceholder(preset.envVar || 'OPENAI_API_KEY')
            .setValue(this.plugin.settings.apiKeyEnvVar)
            .onChange(async (v) => {
              this.plugin.settings.apiKeyEnvVar = v.trim();
              this.plugin.saveSettingsDebounced();
            }),
        );

      new Setting(containerEl)
        .setName(tr('settingAuthTypeName'))
        .setDesc(tr('settingAuthTypeDesc'))
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
        .setName(tr('settingHeadersName'))
        .setDesc(tr('settingHeadersDesc'))
        .addTextArea((t) =>
          t
            .setPlaceholder('cf-aig-authorization: Bearer ...')
            .setValue(this.plugin.settings.apiHeaders)
            .onChange(async (v) => {
              this.plugin.settings.apiHeaders = v;
              this.plugin.saveSettingsDebounced();
            }),
        );

      new Setting(containerEl).setName(tr('settingMaxTokensName')).addText((t) =>
        t.setValue(String(this.plugin.settings.apiMaxTokens)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n > 0) {
            this.plugin.settings.apiMaxTokens = n;
            this.plugin.saveSettingsDebounced();
          }
        }),
      );

      new Setting(containerEl)
        .setName(tr('settingStreamingName'))
        .setDesc(tr('settingStreamingDesc'))
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.streaming ?? true).onChange(async (v) => {
            this.plugin.settings.streaming = v;
            await this.plugin.saveSettings();
          }),
        );
    }

    new Setting(containerEl)
      .setName(tr('settingModelName'))
      .setDesc(tr('settingModelDescApi'))
      .addText((t) =>
        t
          .setPlaceholder(getApiPreset(this.plugin.settings).model || 'model-id')
          .setValue(this.plugin.settings.model)
          .onChange(async (v) => {
            this.plugin.settings.model = v.trim();
            this.plugin.saveSettingsDebounced();
          }),
      );

    new Setting(containerEl)
      .setName(tr('settingMaxInputName'))
      .setDesc(tr('settingMaxInputDesc'))
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxDocChars || DEFAULT_SETTINGS.maxDocChars)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n >= 1000) {
            this.plugin.settings.maxDocChars = n;
            this.plugin.saveSettingsDebounced();
          }
        }),
      );

    containerEl.createEl('h3', { text: tr('promptHeader') });

    new Setting(containerEl)
      .setName(tr('settingPromptLanguageName'))
      .setDesc(tr('settingPromptLanguageDesc'))
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
      .setName(tr('settingCardRangeName'))
      .setDesc(tr('settingCardRangeDesc'))
      .addText((t) =>
        t
          .setPlaceholder('min')
          .setValue(String(this.plugin.settings.minCards || DEFAULT_SETTINGS.minCards))
          .onChange(async (v) => {
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
          .setPlaceholder('max')
          .setValue(String(this.plugin.settings.maxCards || DEFAULT_SETTINGS.maxCards))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n > 0) {
              this.plugin.settings.maxCards = Math.max(n, this.plugin.settings.minCards || DEFAULT_SETTINGS.minCards);
              this.plugin.saveSettingsDebounced();
            }
          }),
      );

    new Setting(containerEl)
      .setName(tr('settingCustomPromptName'))
      .setDesc(tr('settingCustomPromptDesc'))
      .addTextArea((t) => {
        t.inputEl.rows = 8;
        return t
          .setPlaceholder(tr('settingCustomPromptPlaceholder'))
          .setValue(this.plugin.settings.customSystemPrompt || '')
          .onChange(async (v) => {
            this.plugin.settings.customSystemPrompt = v;
            this.plugin.saveSettingsDebounced();
          });
      });

    new Setting(containerEl)
      .setName(tr('settingTestBackendName'))
      .setDesc(tr('settingTestBackendDescApi'))
      .addButton((b) =>
        b.setButtonText('Test').onClick(async () => {
          try {
            const result = await testBackend(this.plugin.settings);
            new Notice(`✓ ${result.slice(0, 180)}`, 8000);
          } catch (e: unknown) {
            new Notice(tr('backendTestFailed', { error: (e as Error).message }), 10000);
          }
        }),
      );

    new Setting(containerEl)
      .setName(tr('settingExportFolderName'))
      .setDesc(tr('settingExportFolderDesc'))
      .addText((t) =>
        t.setValue(this.plugin.settings.exportFolder).onChange(async (v) => {
          this.plugin.settings.exportFolder = v.trim() || DEFAULT_SETTINGS.exportFolder;
          this.plugin.saveSettingsDebounced();
        }),
      );

    containerEl.createEl('h3', { text: tr('cacheHeader') });

    new Setting(containerEl)
      .setName(tr('settingMaxCacheName'))
      .setDesc(tr('settingMaxCacheDesc'))
      .addText((t) => {
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
        t.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') t.inputEl.blur();
        });
        return t;
      });

    const cacheCount = Object.keys(this.plugin.cache).length;
    new Setting(containerEl)
      .setName(tr('cachedNotesName', { count: cacheCount }))
      .setDesc(tr('cachedNotesDesc'))
      .addButton((b) =>
        b
          .setButtonText(tr('clearAllCacheButton'))
          .setWarning()
          .onClick(async () => {
            const n = Object.keys(this.plugin.cache).length;
            await this.plugin.cacheClear();
            new Notice(tr('cacheClearedAll', { count: n }));
            this.display();
          }),
      );
  }
}
