'use strict';

import { STRINGS } from './i18n-strings';
import type { PluginSettings } from './types';

export { STRINGS } from './i18n-strings';

export function resolveUiLanguage(settings: Pick<PluginSettings, 'uiLanguage'> | null): string {
  const configured = settings?.uiLanguage;
  if (configured === 'zh' || configured === 'en') return configured;
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const language = String(nav?.language || '').toLowerCase();
  return language.startsWith('zh') ? 'zh' : 'en';
}

export function translate(
  settings: Pick<PluginSettings, 'uiLanguage'> | null,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const lang = resolveUiLanguage(settings);
  const table = STRINGS[lang] || STRINGS.en;
  const fallback = STRINGS.en[key] || STRINGS.zh[key] || key;
  const template = table[key] || fallback;
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
    return vars && Object.hasOwn(vars, name) ? String(vars[name]) : match;
  });
}
