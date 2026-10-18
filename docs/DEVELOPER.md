# Developer guide

The localization review has two parts: the **translation proxy** between the Supertext plugins and the Supertext AI API, and a **Chrome extension** (in development) for reviewing translations in context. This guide covers how the proxy answers, the review API the extension uses, the architecture, local setup, tests, deployment and releasing. The decisions behind it are in the project doc *Localization review* (`claude/localization-review.md`).

## Repository layout

npm workspaces, one lockfile at the root.

| Path | What it is |
| --- | --- |
| `packages/shared` | Code both parts use: finding segments in a Supertext document, text normalization, markup rules for corrections, review API types. TypeScript sources, no build step (Next.js transpiles them; the extension's bundler will too) |
| `apps/proxy` | The proxy: Next.js 16 (App Router) + PostgreSQL |
| `apps/extension` | The Chrome extension (Manifest V3, TypeScript, built with esbuild into `dist/`) |
| `Dockerfile` | The proxy's production image, built from the repo root |
| `docs/` | These guides and their screenshots (`docs/images/`) |

## How the proxy answers

The proxy speaks the Supertext AI file translation API v1 ([reference](https://github.com/Supertext/Supertext-API-SDK-and-Guide/blob/main/docs/api-reference.md)) under `/v1/`, so the Supertext SDK and every plugin work against it unchanged. The integration tests prove this with the SDK's own TypeScript client.

### Tenants

The `Authorization: Supertext-Auth-Key <key>` header identifies the caller. The tenant is the key's SHA-256 fingerprint (hex, same as the SDK's `apiKeyFingerprint`). The key is forwarded to Supertext on every call that reaches it and is never stored or logged. A missing prefix gets 400 and a malformed key 401, as Supertext answers. Tenants are created the first time Supertext accepts their key.

### Segments and the memory

Every element carrying `data-st-id` in an uploaded document is a **segment** (`scanDocument` in `packages/shared/src/segments.ts`; ids `[A-Za-z0-9_.:-]{1,100}`, first element per id wins, segments don't nest). Script, style, textarea and other raw-text or embedding elements are never segments, even with `data-st-id`: their content isn't text a reviewer may change. Blank segments (no text) pass through untouched.

Documents are read with a small HTML tokenizer (`packages/shared/src/html.ts`) instead of regular expressions: one pass, linear time, so a crafted 1 MB upload takes milliseconds (the hardening tests time ten adversarial inputs). It follows HTML where it matters: quoted attribute values may contain `>`, only HTML whitespace separates attributes, comments end like in browsers (`<!-->`, `--!>`), raw-text content (script, style, …) is never markup, an unfinished tag runs to the end, and start and end tags are paired with a stack (so an end tag inside a comment or script doesn't end a segment).

A segment's memory **key** is SHA-256 over `["v1", tenant, source language or "", target language, politeness or "", normalized source HTML]`. Normalization only unifies line endings, trims outer whitespace and applies Unicode NFC, so any real change to the source is a new segment. Omitted politeness and `default` are the same.

Per key, `segments` stores the source, the AI translation **as first received** (`ai_html`), an optional human correction and what the proxy serves: `correction_html ?? ai_html`. When Supertext translates a known segment again (see *full* mode), its new answer goes to `ai_latest_html` if it differs, and the served translation stays.

### `POST translate/ai/file`

1. Same checks as Supertext: multipart, file part `text/html` exactly (else 415), at most 1,000,000 characters (else 413; counted in UTF-16 units like the SDK's batching). The body is read with a 4.5 MB cap before parsing, also without `Content-Length`. Documents containing NUL get 400 `INVALID_DOCUMENT` (Postgres text can't hold it).
2. Look up every segment. Then one of three modes (`chooseMode` in `jobs.ts`):
   - **full** whenever the document has no segments (Supertext then still checks the language pair), has visible text outside its segments (headings, loose text; the head, scripts, styles and comments don't count, and the head ends at the first body content even without `</head>`), or has missing segments in elements that can't travel alone (`td`, `li`, `option`, …). The whole document goes to Supertext, every time, and the stored segments override Supertext's answer for them.
   - **local**: every segment is known. No upload; the job is `done` immediately. Before answering from the memory alone, the proxy makes sure Supertext still accepts the key (`GET features`, cached per tenant for 10 minutes), so a key revoked at Supertext stops working here too.
   - **reduced**: some segments are missing, all in standalone elements (`div`, `p`, `span`, headings, …; SDK documents always are). Only the missing segments' elements go to Supertext, in the SDK's document shape, with their original ids and attributes.
3. Supertext's answer is passed on unchanged when it isn't 200 (`INVALID_LANGUAGE_PAIR`, `FEATURE_ERROR`, 401/403, 429 with `Retry-After`, …). A network failure is 502 `UPSTREAM_UNREACHABLE`.
4. The proxy answers with its own `file_id` (32 hex characters), stored in `jobs` with the original document for 24 hours.

### Status, translation, delete

- `GET …/{id}/status`: jobs are scoped to the tenant (another key gets 404). For jobs waiting on Supertext, the proxy polls Supertext **only while the plugin polls** (no background worker). When Supertext says `done`, the poll **claims** the job (status `fetching`, `claimed_at`; concurrent polls answer `translating` meanwhile; a claim older than 2 minutes can be taken over), downloads the translation, stores the new segments and only then answers `done`. A failed download releases the claim. `error`, `limit_exceeded` and `deleted` are passed on and kept. Supertext's answers are stored only when they read back unchanged inside a segment element (`isSafeSegmentContent`), and the memory upserts run in key order so overlapping jobs can't deadlock.
- `GET …/{id}/translation`: 404 `NOT_READY` before `done`. The answer is the original document (in *full* mode: Supertext's translated document) with every segment's inner HTML replaced by what the proxy serves now, so a correction made a second ago is in it. A segment Supertext didn't return is dropped from the answer, so the plugin sees it as missing, as it would with Supertext (in *full* mode Supertext's text stays).
- `DELETE …/{id}`: forgets the job and deletes Supertext's file (best effort).
- `GET features` is passed through unchanged.
- Any unexpected failure (database down, a bug) answers 503 `SERVICE_UNAVAILABLE` in Supertext's error shape (`guarded()` in `http.ts`), which the SDK reports as *service unavailable*; the error goes to the log, never to the caller. The review API answers `{ "error": "unavailable" }` the same way.

## Review API

For the Chrome extension, under `/api/review/`. Types: `packages/shared/src/api.ts`. Every request carries the review link's token as `Authorization: Bearer <token>`; no cookies, so CORS allows any origin. Errors are `{ "error": <code>, "detail"? }` with the codes in `ReviewError`. 600 requests per minute per link.

| Call | What it does |
| --- | --- |
| `GET session` | The link's site (name, origin, source language and prefix), target language and prefix, role, expiry |
| `POST match` | `{ side: "translation" \| "source", texts: [{ text }] }` (at most 2000 texts of 5000 characters). For each text, the segments of the link's tenant and target language whose served translation (or source) is exactly that text, at most 10 per text, newest first |
| `GET segments/{id}` | One segment with its AI translation, the newer AI answer if any, and its history (AI translations, corrections, approvals, comments with reviewer and role) |
| `PUT segments/{id}` | A correction: `{ html \| text, reviewer, comment? }`. `text` only for segments without markup (it would drop links). Answers the updated segment |
| `POST segments/{id}/approve` | `{ reviewer, comment? }`: status `approved` |
| `POST segments/{id}/comment` | `{ reviewer, comment }`: a comment only |

A link only reaches segments of its site's tenant and its target language (and, when the site has a source language, segments with that source or a detected one). Anything else is 404.

### Matching page texts

The proxy stores each segment's plain text normalized (`served_text`, `source_text`). The extension normalizes what it reads from the page the same way, so matching is an exact string comparison (indexed by `md5`):

- an element's text: `htmlToText(element.innerHTML)`: tags removed, `<br>` and block tags count as a space, entities decoded;
- an attribute or meta value: `normalizeText(value)`: Unicode NFC, soft hyphens and zero-width characters removed, every run of whitespace (no-break spaces included) one space, trimmed.

Both functions are in `packages/shared/src/text.ts`. Changing them changes what matches: it needs a migration that recomputes the stored texts.

### Markup rules for corrections

Corrections come from outside Supertext and end up on customers' websites, so `checkCorrection` (`packages/shared/src/markup.ts`, on the same tokenizer) only accepts:

- start tags that occur as real tags in the segment's source or its AI translation (whose attributes Supertext may have translated), with exactly the same attributes (name and decoded value, in order), and at most as often as there. Tags inside comments, raw text, `noscript`, `template` or forbidden elements of the source don't count;
- never script-like or embedding elements (`script`, `style`, `iframe`, `object`, `svg`, `form`, …), whatever the source has;
- well-nested markup: every element closed in order, no attributes on end tags; `<br>` may always be added or removed;
- no comments, declarations, unfinished tags, stray `<` or `>`, and no markup smuggled as entities (`&lt;img …&gt;`, zero-padded `&#00060;`, or incomplete ones like `&lt img`), which integrations decode when they read a segment as plain text;
- at most 100,000 characters (checked first), and the result must read back unchanged inside a segment element.

Anything else is 422 `markup_not_allowed`. A stolen link therefore can't inject scripts, styles, event handlers or new links, or break the page.

### Review links

`review_links` holds site, target language, role (`customer` or `linguist`), label and expiry; the token is `<id>.<HMAC-SHA256(REVIEW_LINK_SECRET, "review-link:v1:<id>")>` (base64url). Revoking sets `revoked_at`; changing the secret invalidates every link. A link is `https://<proxy>/review#<token>`: the token is in the fragment, so it never reaches server or proxy logs. The public page `/review` reads it in the browser and asks `GET /api/review/session` what the link is for.

## Usage API

For the Commando Center, which shows which plugins use the proxy (it never handles translations or review links).

```http
GET /api/usage
Authorization: Bearer <REVIEW_USAGE_TOKEN>
```

`200` → `{ "schema": 1, "generatedAt": "<ISO time>", "integrations": [{ "tenant": "<fingerprint>", "tenantLabel": "…", "plugin": "Typo3-Supertext-Translation", "pluginVersion": "0.6.0", "sdk": "php", "keyChecks": 3, "uploads": 42, "memoryAnswers": 17, "firstSeenAt": "…", "lastSeenAt": "…" }] }`, one entry per tenant and plugin (`plugin` is `""` when the User-Agent names none). Never translations, sites or links. `401` with a wrong token; `404` when `REVIEW_USAGE_TOKEN` (at least 32 characters) isn't set. New fields may be added; readers ignore unknown ones.

## Chrome extension

`apps/extension`: Manifest V3, Chrome 140+ (`minimum_chrome_version`; `Tab.splitViewId` exists from 140, the Split View API from 155).

| File | What it does |
| --- | --- |
| `src/panel.ts`, `static/panel.html`, `panel.css` | The side panel and all state: connecting, finding the two tabs, matching through the review API, the lists, the editor. Registered for the whole window (`side_panel.default_path`), so it stays open when the reviewer clicks into the other half of the split view |
| `src/content.ts` | Injected by the panel (`scripting.executeScript`) into both tabs: reads the texts, marks matched blocks (`data-st-review`, `data-st-review-seg`), reports clicks, hovers and scrolling, highlights the selection |
| `src/background.ts` | Opens the panel on the toolbar icon |
| `src/lib/collect.ts` | Reads a page: each block element that directly holds text (`htmlToText(innerHTML)` without nested blocks, so it equals the proxy's `served_text`), and invisible texts: `<title>`, meta description/OG/Twitter, `alt`, `title`, `aria-label`, `placeholder`, button values, JSON-LD names and descriptions |
| `src/lib/split.ts` | Split view: `tabs.create({ splitWithTabId })` (155+), then `tabs.createSplit` if needed; otherwise a normal tab and the shortcut hint. Never `tabs.move` on split tabs (it breaks the split) |
| `src/lib/urls.ts` | The other language's page by swapping the site's path prefixes |
| `src/lib/link.ts`, `api.ts` | Review link parsing (`https://<proxy>/review#<token>`) and the review API client (matches in chunks of 2000) |
| `static/_locales/{en,de,fr,it}` | UI texts (`chrome.i18n`), formal address; a test checks every language has the same keys, placeholders and URLs as English |

- **Which tab is which:** the active tab and its split-view partner (`splitViewId`). With path prefixes the URL decides; without, the tab with more matched translations is the translation.
- **Unmatched texts** on the translated page are matched once more as *originals*: a hit means the page shows the source text (*not translated*); otherwise it doesn't come from the translated content.
- **Safety:** page and proxy content is shown with `textContent` and textarea values only, never as HTML; the content script adds only attributes and one stylesheet. Host access is optional (`optional_host_permissions`) and asked for the review site's origin when a link is connected; the review API is reached through its CORS headers. Extension pages run under a strict CSP (`script-src 'self'`).
- **Build:** `npm run build --workspace apps/extension` → `apps/extension/dist/` (load unpacked); `npm run zip …` → `apps/extension/release/supertext-localization-review-<version>.zip`. The manifest's version must equal `package.json`'s.
- **Tests:** `npm test` runs the unit tests (link and URL rules, page reading in happy-dom, the API client, the UI language check). `npm run test:e2e --workspace apps/extension` builds with `--e2e` (pre-grants `http://127.0.0.1` and `http://localhost`, never released), then loads the extension in Playwright's full Chromium against the proxy's route handlers, the stand-in and a two-language test site (`test/e2e/site/`): connect, open side by side (asserts the native split view, or the hint), check marks on both pages, unmatched and invisible lists, correct from the list, select by clicking the page, refuse a changed link, and get the corrections back through the SDK. Playwright can't drive the real side panel, so the test opens `panel.html?window=<id>` in its own tab; the parameter only chooses the window whose tabs are reviewed. `SCREENSHOTS=1` saves `docs/images/extension-*.png`.

## Data model

| Table | What it holds |
| --- | --- |
| `tenants` | Fingerprint, label and notes (staff), first and last request, the latest User-Agent |
| `segments` | The translation memory (see above), with status `ai`, `corrected` or `approved`, request count and the plugin's User-Agent |
| `segment_events` | History per segment: `ai`, `correction`, `approval`, `comment`, with reviewer, role and link |
| `jobs` | One upload (the proxy's `file_id`): mode, original document, segment keys, Supertext's file id and status, Supertext's document in *full* mode. Deleted after 24 hours |
| `integrations` | Which plugin uses the proxy, per tenant: plugin name and latest version, SDK, User-Agent, counters (key checks, uploads, uploads answered from the memory), first and last request. Parsed from the User-Agent the SDKs send (`supertext-sdk-<language>[/<version>] <Plugin>/<version>`; right after the SDK token the plugin may come without a version, as older Contao releases send it; plugins without the SDK send `<plugin>/<version>`), in `src/lib/integrations.ts`. Recording never fails a request |
| `review_sites` | A customer website: tenant, origin, source language and path prefix, target language prefixes |
| `review_links` | Review links (see above) |

Migrations are plain SQL in `apps/proxy/migrations/`, applied in order by `apps/proxy/scripts/migrate.mjs` before every start (recorded in `schema_migrations`, advisory lock, safe to run again).

## Staff pages

One shared password (`REVIEW_ADMIN_PASSWORD`), signed 14-day session cookie (same as the Commando Center). Logins are limited to 10 per 15 minutes per address (the first `X-Forwarded-For` entry: Railway's edge writes the header, while the last entry can be a shared CDN hop), and past 100 failed logins in 15 minutes from anywhere every attempt waits 3 seconds: a slowdown, not a lockout. Every page and server action calls `requireAuth()`. Public: `/v1/*`, `/api/review/*`, `/api/usage` (its own token), `/review`, `/health`, `/login`. Pages: tenants (`/`), a tenant with its plugins and memory (`/tenants/<fingerprint>`), review sites (`/sites`) and a site with its links (`/sites/<id>`). Segment HTML is always shown as text, never rendered, since it comes from customers' sites. The look is the Commando Center's (`src/app/globals.css`, Inter in `public/fonts/`).

| Path | What it is |
| --- | --- |
| `apps/proxy/src/lib/jobs.ts` | The four file endpoints |
| `apps/proxy/src/lib/memory.ts` | Memory keys, lookups, storing Supertext's answers |
| `apps/proxy/src/lib/upstream.ts` | Calls to Supertext (30 s timeout, no redirects) |
| `apps/proxy/src/lib/tenant.ts` | Reading the caller, fingerprints, the key recheck |
| `apps/proxy/src/lib/review.ts`, `review-links.ts` | The review API and link tokens |
| `apps/proxy/src/lib/admin-store.ts`, `src/app/actions.ts` | Queries and server actions for the staff pages |
| `apps/proxy/src/app/v1/…`, `src/app/api/review/…` | Route handlers (thin: auth, then `src/lib`) |

## Local setup

```sh
npm ci
cp apps/proxy/.env.example apps/proxy/.env   # set the passwords
# a Supertext stand-in with sample translations, so nothing reaches the live API:
PORT=8765 STAND_IN_SAMPLES=apps/proxy/test/fixtures node apps/proxy/test/stand-in/stand-in.mjs &
SUPERTEXT_API_URL=http://127.0.0.1:8765/v1/ npm run dev
```

Point a plugin's demo (or the SDK's conformance program) at `http://127.0.0.1:3000/v1/`. Any key works with the stand-in except `invalid`.

## Tests and CI

```sh
npm run typecheck
npm test                      # unit tests: packages/shared and apps/proxy/test/unit
npm run test:integration      # needs Postgres on 127.0.0.1:5432 (TEST_DATABASE_URL)
```

The integration tests drop and recreate their own databases (`review_test_proxy`, `review_test_review`), start the stand-in on a free port and call the route handlers directly. They drive the proxy with the **Supertext TypeScript SDK client**, so they check the contract the plugins rely on: first request through Supertext, repeats from the memory, only missing segments uploaded, languages/politeness/tenants kept apart, whole-document uploads, errors passed through unchanged, the key recheck, and the review API (links, matching, corrections and their effect on the next request, markup rules, tenant isolation).

`apps/proxy/test/` bundles copies from [Supertext-API-SDK-and-Guide](https://github.com/Supertext/Supertext-API-SDK-and-Guide): the stand-in, `spec/languages.json` and the TypeScript SDK's sources (`test/sdk/`, tests only). Never edit them: `apps/proxy/scripts/vendor-test-deps.sh [ref]` (or `SDK_DIR=<clone>`) replaces them and writes `COMMIT`. CI checks they match that commit.

CI (`.github/workflows/ci.yml`): typecheck, unit and integration tests with Postgres 16, the bundled copies check, and the image check (`apps/proxy/test/image-check.sh`: builds the image, starts it twice on a shared Postgres with the stand-in, checks health, the login redirect, a translation, the repeat from the memory after a restart, and that no secret appears in the log).

### Screenshots

`docs/images/` comes from `apps/proxy/scripts/docs-screenshots.mjs` (Playwright). It translates an invented hotel website through a running proxy, labels the tenant, creates a site and links, corrects one text through the review API and saves cropped 1× PNGs. Steps are at the top of the script: the stand-in with `apps/proxy/scripts/docs-samples`, the proxy with a fresh `REVIEW_DB_NAME` and `REVIEW_PUBLIC_URL=https://review-proxy.example.com`, then `npm run docs:screenshots --workspace apps/proxy`. Open the pages through `http://localhost:…` (not `127.0.0.1`): the production login cookie is `Secure`, which Chrome accepts on plain HTTP only for `localhost`. Regenerate them whenever the pages they show change.

## Code quality and security checks

- **Checks** workflow (`.github/workflows/checks.yml`): actionlint and zizmor on every push and pull request; dependency review fails pull requests that add a package with a known vulnerability (moderate or worse). Actions are pinned to commit SHAs; checkouts use `persist-credentials: false`. Locally: `pip install actionlint-py zizmor`, then `actionlint` and `zizmor --offline .github/workflows`.
- **Links** workflow (`.github/workflows/links.yml`): lychee checks the Markdown links weekly and when docs change; broken links open the issue "Broken links in the docs".
- **Support triage** (`.github/workflows/support-triage.yml`): the same file as in every plugin repo (master copy in `Supertext-Integrations-Marketing`). Issues labelled `support` start Claude, which answers questions, fixes bugs on a branch with a pull request for review, or labels feature requests.
- CodeQL default setup and secret scanning with push protection are on (Remy's setup script).
- Security rules: API keys, the admin password and the link secret never appear in logs or the database (the image check greps the log). Corrections may only use the source's markup. Review links are scoped to one tenant and language. Jobs are scoped to the key that created them. The staff pages render customer content as text only. Document handling is linear-time (no backtracking regexes on uploaded content).
- An independent review (October 2026) checked cross-tenant isolation, markup injection, document handling under adversarial input, drop-in compatibility, tokens, SQL and concurrency; its cases are in `packages/shared/test/hardening.test.ts` and `apps/proxy/test/integration/hardening.test.ts`.

## Dependency updates

Dependabot opens weekly pull requests (npm minor and patch grouped, Docker, GitHub Actions). Keep TypeScript 5 and `@types/node` 22 (majors ignored in `.github/dependabot.yml`) and the Node 22 image. Create the lockfile with `npx npm@11 install` (npm 10 crashes on Vitest 5's optional peers next to Next 16).

## Releasing

Releases are published by `.github/workflows/release.yml` when the version is officially bumped; nobody tags or creates releases by hand.

1. Check that `npm run typecheck && npm test && npm run test:integration` pass.
2. Move the *Unreleased* entries in `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` section, below an empty *Unreleased*.
3. Set the same version in `package.json`, `apps/proxy/package.json` (the footer shows it, linked to the release), `packages/shared/package.json`, `apps/extension/package.json` and `apps/extension/static/manifest.json`. The release gets the extension's zip attached.
4. Push to `main`. The workflow checks the version files, tags `vX.Y.Z` and creates the release (0.x as pre-releases). Railway deploys every push to `main` independently.

## Known limitations / roadmap

- **Chrome Web Store:** the extension is installed unpacked from the release zip until it is listed (see the installation guide).
- **Write-back:** corrections reach the CMS on the plugin's next request for that text. A push to the CMS (for content that isn't translated again) is planned in the SDK, so it is built once for all plugins.
- **Plugins' API URL:** switching a plugin to the proxy needs its base URL setting or environment variable. Check each plugin's installation guide; plugins that only have it for tests need a real setting first.
- **Text split across elements** or changed by templates doesn't match exactly; the optional website proxy with segment markers (project doc) would cover it.
- **Translation memory per tenant only:** no sharing between a customer's keys yet (a customer with several keys has several tenants).
- One shared staff password, no per-person accounts. Rate limits and the key recheck cache live in memory: fine for one instance.
- `jobs` keeps each uploaded document for 24 hours (needed to build the answer), cleaned up on the next upload.
