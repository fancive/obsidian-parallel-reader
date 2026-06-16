'use strict';

import { translate } from './i18n';
import type { PluginSettings } from './types';

export type RequestUrlFunction = (params: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  throw?: boolean;
}) => Promise<{ status: number; json: unknown; text: string }>;

/**
 * Thrown when a provider responds with HTTP >= 400. Carries the raw status code
 * and response body so callers can make locale-independent decisions (e.g. the
 * structured-output fallback) instead of pattern-matching a translated message.
 */
export class ProviderApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'ProviderApiError';
    this.status = status;
    this.body = body;
  }
}

export function endpointUrl(baseUrl: string, suffixes: string[]) {
  const base = baseUrl.replace(/\/+$/, '');
  for (const suffix of suffixes) {
    if (base.endsWith(suffix)) return base;
  }
  return base + suffixes[0];
}

export function responseJson(
  resp: { json: unknown; text: string },
  label: string,
  settings?: PluginSettings | null,
): Record<string, unknown> {
  if (resp.json && typeof resp.json === 'object') return resp.json as Record<string, unknown>;
  try {
    return JSON.parse(resp.text || '{}') as Record<string, unknown>;
  } catch (cause: unknown) {
    throw new Error(
      translate(settings || null, 'errorProviderNonJson', {
        label,
        excerpt: (resp.text || '').slice(0, 500),
      }),
      { cause },
    );
  }
}

export async function requestJsonBody(
  requestUrlImpl: RequestUrlFunction,
  label: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  settings?: PluginSettings | null,
): Promise<Record<string, unknown>> {
  let resp: { status: number; json: unknown; text: string };
  try {
    resp = await requestUrlImpl({
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e: unknown) {
    throw new Error(
      translate(settings || null, 'errorProviderRequestFailed', {
        label,
        error: e instanceof Error ? e.message : String(e),
      }),
    );
  }

  if (resp.status >= 400) {
    throw new ProviderApiError(
      translate(settings || null, 'errorProviderApiStatus', {
        label,
        status: resp.status,
        excerpt: (resp.text || '').slice(0, 500),
      }),
      resp.status,
      resp.text || '',
    );
  }
  return responseJson(resp, label, settings);
}

// Bare `unknown`/`unrecognized` were intentionally dropped: they false-positive on
// model-name errors ("unknown model", "unrecognized model ID") and trigger a wasted
// fallback retry. The specific feature tokens + bare `schema` cover real structured-
// output rejections (e.g. "Unknown field: responseSchema" still matches `schema`).
const STRUCTURED_OUTPUT_REJECTION_KEYWORDS =
  /response_format|json_schema|responseJsonSchema|responseMimeType|tools?|tool_choice|unsupported|schema/i;
const STRUCTURED_OUTPUT_FALLBACK_STATUSES = new Set([400, 404, 422]);

export function shouldRetryWithoutStructuredOutput(error: unknown): boolean {
  // Preferred path: decide on the locale-independent HTTP status + raw provider body.
  // The error message is i18n-translated, so matching it would only work for the two
  // languages whose templates happen to contain the English/Chinese status phrasing.
  if (error instanceof ProviderApiError) {
    if (!STRUCTURED_OUTPUT_FALLBACK_STATUSES.has(error.status)) return false;
    return (
      STRUCTURED_OUTPUT_REJECTION_KEYWORDS.test(error.body) || STRUCTURED_OUTPUT_REJECTION_KEYWORDS.test(error.message)
    );
  }
  // Fallback for errors without a status (e.g. wrapped transport failures): keep the
  // legacy English/Chinese template match so existing behavior is preserved.
  const message = error instanceof Error ? error.message : String(error);
  if (!/(?:API (?:400|404|422):|API returned HTTP (?:400|404|422)|API 返回 HTTP (?:400|404|422))/.test(message))
    return false;
  return STRUCTURED_OUTPUT_REJECTION_KEYWORDS.test(message);
}

export async function requestJsonBodyWithStructuredFallback(
  requestUrlImpl: RequestUrlFunction,
  label: string,
  url: string,
  headers: Record<string, string>,
  structuredBody: unknown,
  fallbackBody: unknown,
  settings?: PluginSettings | null,
): Promise<Record<string, unknown>> {
  try {
    return await requestJsonBody(requestUrlImpl, label, url, headers, structuredBody, settings);
  } catch (e: unknown) {
    if (!fallbackBody || !shouldRetryWithoutStructuredOutput(e)) throw e;
    console.warn(`[parallel-reader] ${label} structured output rejected; retrying without structured output`, e);
    return requestJsonBody(requestUrlImpl, label + ' fallback', url, headers, fallbackBody, settings);
  }
}
