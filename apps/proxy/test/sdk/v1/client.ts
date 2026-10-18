/**
 * Client for the Supertext AI file translation API v1:
 *
 *   1. POST   translate/ai/file                   multipart upload of an HTML file → { file_id }
 *   2. GET    translate/ai/file/{id}/status       poll until `done`
 *   3. GET    translate/ai/file/{id}/translation  download the translated HTML
 *   4. DELETE translate/ai/file/{id}              always, best effort (files expire after 24 h)
 */
import { authHeader, retryDelayMs } from './auth.js'
import { DEFAULT_MAX_CHARACTERS, isBlank, planBatches, type KeyedSegment } from './batching.js'
import { errorForFileStatus, errorForStatus, SupertextError } from './errors.js'
import { build, parse, type Segment } from './html-document.js'
import { encodeMultipart, type MultipartBody } from './multipart.js'
import { apiKeyCheckFromError, apiKeyFingerprint, isoSeconds, KEY_CHECK_TIMEOUT_MS, type ApiKeyCheck } from './api-key-check.js'

export const LIVE_BASE_URL = 'https://api.supertext.com/v1/'

/** `more`: formal address (Sie, vous, Lei). `less`: informal (du, tu). `default`: Supertext decides. */
export type Politeness = 'default' | 'more' | 'less'

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface SupertextClientOptions {
  /** Default: the live API. A trailing slash is added if missing. */
  baseUrl?: string
  /** Wait between status polls. Default 2000 ms. */
  pollIntervalMs?: number
  /** Give up waiting for a translation after this long. Default 180000 ms. */
  timeoutMs?: number
  /** Timeout of a single HTTP request. Default 30000 ms. */
  requestTimeoutMs?: number
  /** Retries after HTTP 429 (the API limits requests per second). Default 4. */
  maxRetries?: number
  /** Appended to the User-Agent, e.g. `Payload-Supertext-Translation/1.2.0`. */
  userAgent?: string
  /** HTTP implementation (proxies, tests). Default: the global `fetch`. */
  fetch?: FetchLike
  /** Sleep implementation (tests). */
  sleep?: (ms: number) => Promise<void>
  /** Clock in milliseconds (tests). Default `Date.now`. */
  now?: () => number
}

/** One language pair from `GET features`. */
export interface FeatureSupport {
  sourceLang: string
  targetLang: string
  /** E.g. `supports_politeness`, `supports_glossary`. */
  features: string[]
}

export interface TranslateOptions {
  /** Source language; any form (`en`, `en-US`, `en_GB`), sent bare. Omitted or empty: auto-detect. */
  sourceLang?: string | null
  politeness?: Politeness
}

export interface TranslateTextsOptions extends TranslateOptions {
  /** Maximum packed characters per document. Default 900000. */
  maxCharacters?: number
}

/** Segments for `translateTexts`: a Map or a plain object, key → segment (a string is plain text). */
export type SegmentInput = Segment | string
export type Segments = ReadonlyMap<string, SegmentInput> | Readonly<Record<string, SegmentInput>>

const SDK_USER_AGENT = 'supertext-sdk-typescript'
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class SupertextClient {
  // A #private field: never shows up in console.log, util.inspect or JSON.
  readonly #apiKey: string
  readonly #fetch: FetchLike
  readonly #userAgent: string
  readonly baseUrl: string
  readonly pollIntervalMs: number
  readonly timeoutMs: number
  readonly requestTimeoutMs: number
  readonly maxRetries: number
  readonly #sleep: (ms: number) => Promise<void>
  readonly #now: () => number

  /** A blank key doesn't throw here: the first request throws `missing_api_key` without sending anything. */
  constructor(apiKey: string, options: SupertextClientOptions = {}) {
    this.#apiKey = apiKey ?? ''
    const base = options.baseUrl ?? LIVE_BASE_URL
    this.baseUrl = base.endsWith('/') ? base : `${base}/`
    this.pollIntervalMs = options.pollIntervalMs ?? 2000
    this.timeoutMs = options.timeoutMs ?? 180_000
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    this.maxRetries = options.maxRetries ?? 4
    this.#userAgent = options.userAgent ? `${SDK_USER_AGENT} ${options.userAgent}` : SDK_USER_AGENT
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.#sleep = options.sleep ?? defaultSleep
    this.#now = options.now ?? Date.now
  }

  /**
   * The language pairs the API offers right now, with their features (`supports_politeness`, …):
   * the live version of `Languages.SOURCES`/`TARGETS`, e.g. for a settings page. Cost-free.
   */
  async getFeatures(): Promise<FeatureSupport[]> {
    const list = jsonObject(await this.#request('GET', 'features'))?.supported_features
    if (!Array.isArray(list)) return []
    return list.flatMap((item: unknown) => {
      const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
      if (typeof o.source_lang !== 'string' || typeof o.target_lang !== 'string') return []
      const features = Array.isArray(o.features) ? o.features.filter((f): f is string => typeof f === 'string') : []
      return [{ sourceLang: o.source_lang, targetLang: o.target_lang, features }]
    })
  }

  /** Cost-free check that the API key is accepted (`GET features`). Throws a `SupertextError` if not. */
  async validateApiKey(): Promise<void> {
    await this.#request('GET', 'features')
  }

  /**
   * The automatic API key check (spec/api-key-check.json): `GET features` with a
   * 10 s timeout, mapped to `ok`, `invalid`, `missing`, `unreachable` or `error`.
   * Never throws. A blank key gives `missing` without a request.
   */
  async checkApiKey(): Promise<ApiKeyCheck> {
    const checkedAt = isoSeconds(this.#now())
    const fingerprint = apiKeyFingerprint(this.#apiKey)
    if (fingerprint === '') return { status: 'missing', checkedAt, httpStatus: null, errorCode: null, fingerprint }
    try {
      const status = await this.#request('GET', 'features', undefined, Math.min(KEY_CHECK_TIMEOUT_MS, this.requestTimeoutMs), true)
      return { status: 'ok', checkedAt, httpStatus: Number(status), errorCode: null, fingerprint }
    } catch (error) {
      return { ...apiKeyCheckFromError(error), checkedAt, fingerprint }
    }
  }

  /**
   * Uploads an HTML document; returns the file id. The language codes are sent as given
   * (trimmed): resolve CMS languages with `Languages.target()` / `Languages.source()` first.
   */
  async submit(html: string, targetLang: string, options: TranslateOptions = {}): Promise<string> {
    const target = targetLang.trim()
    if (target === '') throw new SupertextError('unsupported_language')
    const fields: [string, string][] = [['target_lang', target]]
    const source = (options.sourceLang ?? '').trim()
    if (source !== '') fields.push(['source_lang', source]) // omitted: auto-detect
    const politeness = options.politeness
    if (politeness === 'more' || politeness === 'less') fields.push(['politeness', politeness])
    // The part's Content-Type must be exactly "text/html": the API rejects a charset
    // parameter with HTTP 415. The document declares UTF-8 in <meta charset>.
    const form = encodeMultipart(fields, { name: 'file', filename: 'content.html', contentType: 'text/html', content: html })

    const data = jsonObject(await this.#request('POST', 'translate/ai/file', form))
    const fileId = data?.file_id
    if (typeof fileId !== 'string' || fileId === '') throw new SupertextError('no_file_id')
    return fileId
  }

  /** The file's status: `translating`, `done`, `error`, `limit_exceeded`, `deleted` (others are possible). */
  async getStatus(fileId: string): Promise<string> {
    const status = jsonObject(await this.#request('GET', `translate/ai/file/${encodeURIComponent(fileId)}/status`))?.status
    return typeof status === 'string' ? status : ''
  }

  /** Polls until the file is `done`; throws on `error`, `limit_exceeded`, `deleted` or after `timeoutMs`. */
  async waitUntilDone(fileId: string): Promise<void> {
    const started = this.#now()
    for (;;) {
      const status = await this.getStatus(fileId)
      if (status === 'done') return
      const error = errorForFileStatus(status)
      if (error) throw error
      // Unknown statuses (e.g. `queued`) keep polling.
      if (this.#now() - started + this.pollIntervalMs > this.timeoutMs) throw new SupertextError('timeout')
      await this.#sleep(this.pollIntervalMs)
    }
  }

  /** The translated HTML document. */
  async download(fileId: string): Promise<string> {
    const body = await this.#request('GET', `translate/ai/file/${encodeURIComponent(fileId)}/translation`)
    if (body.trim() === '') throw new SupertextError('incomplete_response', { detail: 'empty document' })
    return body
  }

  /** Deletes the file. Never throws: files expire after 24 h anyway. */
  async delete(fileId: string): Promise<void> {
    try {
      await this.#request('DELETE', `translate/ai/file/${encodeURIComponent(fileId)}`)
    } catch {
      // Best effort.
    }
  }

  /** Full round trip for one HTML document: upload, wait, download, and always delete. */
  async translateHtml(html: string, targetLang: string, options: TranslateOptions = {}): Promise<string> {
    const fileId = await this.submit(html, targetLang, options)
    try {
      await this.waitUntilDone(fileId)
      return await this.download(fileId)
    } finally {
      await this.delete(fileId)
    }
  }

  /**
   * Translates texts and HTML fragments, keyed by your own ids. Returns the
   * same keys in the same order (a Map for a Map, an object for an object).
   * Blank texts come back unchanged; segments are packed into as few documents
   * as possible, translated one after the other (the API limits requests per second).
   */
  translateTexts(segments: ReadonlyMap<string, SegmentInput>, targetLang: string, options?: TranslateTextsOptions): Promise<Map<string, string>>
  translateTexts(segments: Readonly<Record<string, SegmentInput>>, targetLang: string, options?: TranslateTextsOptions): Promise<Record<string, string>>
  async translateTexts(segments: Segments, targetLang: string, options: TranslateTextsOptions = {}): Promise<Map<string, string> | Record<string, string>> {
    const isMap = segments instanceof Map
    const entries: [string, SegmentInput][] = isMap ? [...(segments as ReadonlyMap<string, SegmentInput>)] : Object.entries(segments)
    const keyed: KeyedSegment[] = entries.map(([key, s]) =>
      typeof s === 'string' ? { key, text: s, html: false } : { key, text: s.text, html: s.html ?? false },
    )

    const translated = new Map<string, string>()
    for (const batch of planBatches(keyed, options.maxCharacters ?? DEFAULT_MAX_CHARACTERS)) {
      const html = await this.translateHtml(build(batch), targetLang, options)
      const results = parse(html, batch)
      const missing = batch.filter((_, i) => results[i] === null).map((s) => s.key)
      if (missing.length > 0) throw new SupertextError('incomplete_response', { detail: `missing: ${missing.join(', ')}` })
      batch.forEach((s, i) => translated.set(s.key, results[i]!))
    }

    const out = keyed.map((s) => [s.key, isBlank(s.text) ? s.text : translated.get(s.key)!] as const)
    return isMap ? new Map(out) : Object.fromEntries(out)
  }

  /** One HTTP request with auth, retries on 429 and error mapping. Returns the body text of a 2xx answer. */
  async #request(method: string, path: string, form?: MultipartBody, timeoutMs = this.requestTimeoutMs, returnStatus = false): Promise<string> {
    const authorization = authHeader(this.#apiKey) // throws missing_api_key before anything is sent
    // Never let the key reach a message, even if a proxy echoes the request back.
    const key = authorization.slice('Supertext-Auth-Key '.length)
    const scrub = (text: string) => text.split(key).join('***')
    const headers: Record<string, string> = { Authorization: authorization, Accept: 'application/json', 'User-Agent': this.#userAgent }
    if (form) headers['Content-Type'] = form.contentType
    for (let attempt = 0; ; attempt++) {
      let response: Response
      let text: string
      try {
        const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) }
        if (form) init.body = form.body
        response = await this.#fetch(this.baseUrl + path, init)
        text = await response.text()
      } catch (error) {
        throw new SupertextError('transport_error', { detail: scrub(errorMessage(error)), cause: error })
      }
      if (response.status === 429 && attempt < this.maxRetries) {
        await this.#sleep(retryDelayMs(attempt, response.headers.get('retry-after')))
        continue
      }
      if (!response.ok) throw errorForStatus(response.status, scrub(text))
      return returnStatus ? String(response.status) : text
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    // fetch wraps the real reason (ECONNREFUSED, DNS, TLS) in `cause`.
    const cause = (error as { cause?: unknown }).cause
    return cause instanceof Error && cause.message ? `${error.message}: ${cause.message}` : error.message
  }
  return String(error)
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
