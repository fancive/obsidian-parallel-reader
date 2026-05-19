'use strict';

import { STRINGS } from './i18n-strings';
import type { PluginSettings } from './types';

export { LOCALE_OVERRIDES, STRINGS } from './i18n-strings';

function supportedBaseLanguage(value: unknown): string | null {
  const base = String(value || '')
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  return base && STRINGS[base] ? base : null;
}

export function resolveUiLanguage(settings: Pick<PluginSettings, 'uiLanguage'> | null): string {
  const configured = settings?.uiLanguage;
  if (configured && configured !== 'auto') {
    return supportedBaseLanguage(configured) || 'en';
  }
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  return supportedBaseLanguage(nav?.language) || 'en';
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
