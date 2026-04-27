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
  } catch (_) {
    throw new Error(
      translate(settings || null, 'errorProviderNonJson', {
        label,
        excerpt: (resp.text || '').slice(0, 500),
      }),
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
    throw new Error(
      translate(settings || null, 'errorProviderApiStatus', {
        label,
        status: resp.status,
        excerpt: (resp.text || '').slice(0, 500),
      }),
    );
  }
  return responseJson(resp, label, settings);
}

export function shouldRetryWithoutStructuredOutput(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!/(?:API (?:400|404|422):|API returned HTTP (?:400|404|422)|API 返回 HTTP (?:400|404|422))/.test(message))
    return false;
  return /response_format|json_schema|responseJsonSchema|responseMimeType|tools?|tool_choice|unsupported|unrecognized|unknown|schema/i.test(
    message,
  );
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
