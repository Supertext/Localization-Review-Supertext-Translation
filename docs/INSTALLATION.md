# Installation guide

For Supertext staff who run the translation proxy. The Chrome extension's installation will be added here once it is released.

## Requirements

- A Railway project (the plugins' demos run in *supertext-cms-demos*) with a PostgreSQL service. The proxy can share the Postgres server with other services: it creates and uses its own database (`REVIEW_DB_NAME`).
- Node.js 22 and PostgreSQL 16 for local development.

## Deploy on Railway

1. Create a service from the GitHub repo **Supertext/Localization-Review-Supertext-Translation**, region `ams`.
2. Settings: builder **Dockerfile**, path `Dockerfile` (repo root), healthcheck path `/health`, restart on failure. Railway ignores `railway.json`, so set these on the service.
3. Variables (see the table below): at least `DATABASE_URL` (reference the Postgres service, e.g. `${{Postgres.DATABASE_URL}}`), `REVIEW_DB_NAME`, `REVIEW_ADMIN_PASSWORD` and `REVIEW_LINK_SECRET`.
4. Generate a domain (or add a custom one) and set `REVIEW_PUBLIC_URL` to it.
5. Deploy. Every start applies the database migrations first; `/health` answers `ok` once the app reaches its database. Railway deploys every push to `main`.

| Variable | Required | What it does |
| --- | --- | --- |
| `DATABASE_URL` | yes | The Postgres server |
| `REVIEW_DB_NAME` | recommended | The proxy's own database on that server (lower case, digits, `_`); created on first start |
| `REVIEW_ADMIN_PASSWORD` | yes | Shared password for the staff pages, at least 12 characters. Changing it signs everyone out |
| `REVIEW_LINK_SECRET` | for review links | Signs review links, at least 32 random characters (`openssl rand -base64 33`). Changing it invalidates **every** review link |
| `REVIEW_USAGE_TOKEN` | for the Commando Center | Token the Commando Center uses to read which plugins use the proxy (`/api/usage`), at least 32 random characters. Set the same value as `COMMANDO_PROXY_TOKEN` on the Commando Center |
| `REVIEW_PUBLIC_URL` | recommended | The proxy's public address, used in review links (default: the address the staff page was opened with) |
| `SUPERTEXT_API_URL` | no | The Supertext API the proxy forwards to. Default `https://api.supertext.com/v1/`. Only tests change it |
| `REVIEW_TIMEZONE` | no | Time zone for dates in the UI (default `Europe/Zurich`) |

Never put the values in the repo, in chat or in logs.

## The Chrome extension

Reviewers need Google Chrome 140 or newer (155+ opens the side-by-side view by itself; older versions show the shortcut). Until the extension is in the Chrome Web Store:

1. Download `supertext-localization-review-<version>.zip` from the latest [GitHub release](https://github.com/Supertext/Localization-Review-Supertext-Translation/releases) and unzip it.
2. Open `chrome://extensions`, turn on *Developer mode* (top right), click *Load unpacked* and choose the unzipped folder.
3. Pin the extension (puzzle icon → pin) so its icon is in the toolbar.

The same zip is what goes to the Chrome Web Store (Developer Dashboard → new item → upload; the listing needs the four screenshots in `docs/images/extension-*.png`, the description and a privacy note: the extension reads the pages of the review site only while a review link is connected, and sends their texts only to the review service of that link).

Permissions: *side panel*, *storage* (the review link and the reviewer's name), *tabs* and *scripting* (to find the two pages and read them). Access to a website is asked for when a review link for it is connected, never for all sites.

## Pointing a plugin at the proxy

The proxy answers exactly like the Supertext AI file translation API v1 under `https://<proxy>/v1/`. Nothing changes in the plugin except its **Supertext API URL**: the plugin's base URL setting or environment variable (each plugin's `docs/INSTALLATION.md` names it). The plugin keeps its own API key; the proxy forwards it to Supertext with every call that reaches Supertext, so billing, language pairs and errors stay Supertext's.

- No Supertext account yet? Create one at https://www.supertext.com/person/en/account/signin. Generate your API key at https://www.supertext.com/en/integrations/api (supertext.com → Integrations → API; requires the Admin role).
- The key check (*Test connection*, the automatic check on save) goes through the proxy too: `GET features` is passed on to Supertext unchanged.
- The first translation through the proxy creates the customer's **tenant** in the staff pages. Label it there (see the user guide).

What changes for the customer: texts the proxy has translated before come back with the stored translation (or the reviewed one) without a new Supertext call. New texts go to Supertext as before.

## Update

Push to `main`; Railway rebuilds and restarts. Migrations run at start and are safe to run again.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `/health` answers 503 | The app can't reach Postgres: check `DATABASE_URL` and that the Postgres service runs |
| Login page says login is not configured | `REVIEW_ADMIN_PASSWORD` missing or shorter than 12 characters |
| The site page says review links need a secret | `REVIEW_LINK_SECRET` missing or shorter than 32 characters |
| Every review link says it is not valid | `REVIEW_LINK_SECRET` was changed: create new links |
| A plugin gets HTTP 502 `UPSTREAM_UNREACHABLE` | The proxy can't reach Supertext (network, DNS, Supertext down). The plugin shows its usual "service unavailable" message; retry later |
| A plugin gets 401 for texts it translated before | Supertext rejects the key. The proxy checks the key with Supertext at least every 10 minutes, even when it could answer from its memory, so revoked keys stop working |
| No tenant appears after a translation | The plugin isn't using the proxy: check its API URL (it must end in `/v1/`) |
