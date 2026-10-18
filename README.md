# Supertext Localization Review

Humans review the AI translations of a website in context, and their corrections stick. Two parts:

- **Translation proxy** (`apps/proxy`): sits between the [Supertext translation plugins](https://github.com/Supertext) and the Supertext AI API and speaks exactly the same API, so a plugin switches by changing its API URL. It keeps every translation per customer, so the same text always gets the same translation, and serves reviewers' corrections from then on. Texts it already knows are answered without calling Supertext. Staff pages show each customer's translation memory and manage review links.
- **Chrome extension** (`apps/extension`): opens the original and the translated page side by side in Chrome's split view and marks every text the proxy translated. A side panel (English, German, French, Italian) lets reviewers correct, approve and comment on texts, and lists texts that weren't matched (with the likely reason) and invisible ones (title, meta tags, alt texts, structured data).

The extension talks to the proxy through the review API; both share `packages/shared` (segments, text normalization, markup rules, API types).

Next.js and PostgreSQL, deployed on Railway.

## Documentation

- [Installation guide](docs/INSTALLATION.md): deploy on Railway, settings, pointing a plugin at the proxy, troubleshooting
- [User guide](docs/USER_GUIDE.md): tenants, the translation memory, review sites and links
- [Developer guide](docs/DEVELOPER.md): how the proxy answers, the review API, architecture, tests, releasing

## License

MIT, see [LICENSE](LICENSE).
