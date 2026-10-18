# Working on this repository

**Supertext Localization Review**: a translation proxy between the Supertext plugins and the Supertext AI API (`apps/proxy`, Next.js 16 + PostgreSQL, Railway) and a Chrome extension for reviewing translations in context (`apps/extension`, coming), sharing `packages/shared`. Part of Supertext's translation plugins project; the shared conventions (docs, repo setup, checks, releases, dependency updates) apply here too. Plan and decisions: the project doc `claude/localization-review.md`.

## Always

- **Docs in the same commit:** `docs/INSTALLATION.md` (deploy, settings, pointing a plugin at the proxy, troubleshooting), `docs/USER_GUIDE.md` (staff pages, later reviewers, with screenshots), `docs/DEVELOPER.md` (how the proxy answers, review API, architecture, tests, releasing). `CHANGELOG.md` gets an entry under *Unreleased* for every visible change; `README.md` stays a short overview.
- **The proxy is a drop-in for the Supertext API v1.** Plugins in the field must work against it unchanged: same paths, fields, statuses and error answers. Supertext's non-200 answers are passed on as they are. Every change to `/v1/` keeps the integration tests that drive it with the SDK client green; new API behaviour learned here goes to Supertext-API-SDK-and-Guide too.
- **Never serve one tenant's translations to another.** Memory keys, jobs, review links and every query are scoped by the key's fingerprint. Never store or log API keys, the admin password or the link secret.
- **Corrections end up on customers' websites:** never weaken `checkCorrection` (source markup only) and never render segment HTML in the staff pages (text only).
- **No backtracking regexes on uploaded or reviewer content:** documents and corrections go through the linear tokenizer in `packages/shared/src/html.ts`; keep the timing cases in the hardening tests passing.
- `packages/shared/src/text.ts` defines how page texts match stored texts; changing it needs a migration that recomputes `served_text` and `source_text`.
- The test copies in `apps/proxy/test/` (stand-in, languages, TypeScript SDK) are never edited: `apps/proxy/scripts/vendor-test-deps.sh [ref]`.
- UI changes: regenerate the screenshots (`docs/DEVELOPER.md` → *Screenshots*). The staff UI stays in English; the extension's UI will be in English, German, French and Italian.
- Every staff page and server action calls `requireAuth()`; only `/v1/*`, `/api/review/*`, `/api/usage` (its own token), `/review`, `/health` and `/login` are public. `/api/usage` is for the Commando Center and carries usage only, never translations, sites or links.

## Before committing

`npm run typecheck && npm test && npm run test:integration` (Postgres on 127.0.0.1:5432, see the developer guide). Image changes: `docker build -t review-proxy . && apps/proxy/test/image-check.sh`. Workflow changes: `actionlint` and `zizmor --offline .github/workflows`. Lockfile: `npx npm@11 install`.

## Releases

`.github/workflows/release.yml` publishes when `CHANGELOG.md` gets a new `## [X.Y.Z] - YYYY-MM-DD` section and `package.json`, `apps/proxy/package.json` and `packages/shared/package.json` carry the same version. Never tag by hand. Railway deploys every push to `main`.

## Checks and alerts

Before starting work, look at the open findings and fix what the task touches or what is quick: code scanning alerts (`gh api 'repos/Supertext/Localization-Review-Supertext-Translation/code-scanning/alerts?state=open'`), secret scanning alerts, open Dependabot PRs and the issue "Broken links in the docs".

## Repo setup

`LICENSE` (MIT), `SECURITY.md`, `.github/dependabot.yml`, `checks.yml`, `links.yml`, `support-triage.yml` (same file as in the plugin repos), CI and release workflows. Claude sessions can't change GitHub repo settings: the repo belongs in Remy's setup script (`set-github-about`).

## Dependency updates

Keep TypeScript 5 and `@types/node` 22 (Dependabot ignores their majors) and the Node 22 image.
