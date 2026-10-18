/**
 * Which plugins use the proxy. The Supertext SDKs send
 * `User-Agent: supertext-sdk-<language>[/<version>] <Plugin>/<version>`
 * (e.g. `supertext-sdk-php Typo3-Supertext-Translation/0.6.0`); some send the
 * plugin's name without a version after the SDK token (Contao:
 * `supertext-sdk-php Contao-Supertext-Translation`); plugins without the SDK send
 * their own name and version. The proxy records one row
 * per tenant and plugin with the latest version and simple counters.
 */
import { db } from './db';
import type { Caller } from './tenant';

export interface ParsedUserAgent {
  /** The plugin's name, '' if the User-Agent names none. */
  plugin: string;
  version: string;
  /** php, typescript, python, dotnet, java, … or ''. */
  sdk: string;
}

const SDK_TOKEN = /^supertext-sdk-([a-z]{1,20})(?:\/\S{0,40})?$/i;
const PRODUCT = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})(?:\/(\S{1,40}))?$/;
/** Tokens that are never the plugin: HTTP clients and runtimes. */
const GENERIC = /^(mozilla|node|node-fetch|undici|axios|guzzlehttp|guzzle|curl|php|python-requests|python|okhttp|java|dotnet|\.net|wordpress|symfony|httpclient|go-http-client|supertext-review-proxy)$/i;

export function parseUserAgent(ua: string): ParsedUserAgent {
  let sdk = '';
  let plugin = '';
  let version = '';
  for (const token of ua.trim().split(/\s+/).slice(0, 20)) {
    const s = SDK_TOKEN.exec(token);
    if (s) {
      sdk ||= s[1]!.toLowerCase();
      continue;
    }
    const p = PRODUCT.exec(token);
    // A name without a version only counts right after the SDK token.
    if (p && !plugin && !GENERIC.test(p[1]!) && (p[2] !== undefined || sdk)) {
      plugin = p[1]!;
      version = p[2] ?? '';
    }
  }
  return { plugin, version, sdk };
}

export type IntegrationEvent = 'key_check' | 'upload' | 'memory_answer';

/** Counts a request of the caller's plugin. Never fails the request. */
export async function recordIntegration(caller: Caller, event: IntegrationEvent): Promise<void> {
  const p = parseUserAgent(caller.userAgent);
  const keyChecks = event === 'key_check' ? 1 : 0;
  const uploads = event === 'key_check' ? 0 : 1;
  const memory = event === 'memory_answer' ? 1 : 0;
  try {
    await db()`
      INSERT INTO integrations (tenant, plugin, plugin_version, sdk, user_agent, key_checks, uploads, memory_answers)
      VALUES (${caller.tenant}, ${p.plugin}, ${p.version}, ${p.sdk}, ${caller.userAgent}, ${keyChecks}, ${uploads}, ${memory})
      ON CONFLICT (tenant, plugin) DO UPDATE SET
        plugin_version = EXCLUDED.plugin_version,
        sdk = EXCLUDED.sdk,
        user_agent = EXCLUDED.user_agent,
        key_checks = integrations.key_checks + EXCLUDED.key_checks,
        uploads = integrations.uploads + EXCLUDED.uploads,
        memory_answers = integrations.memory_answers + EXCLUDED.memory_answers,
        last_seen_at = now()`;
  } catch {
    // Statistics only: a failure here must never fail a translation.
  }
}
