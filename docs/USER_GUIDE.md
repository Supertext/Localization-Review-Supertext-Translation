# User guide

For Supertext staff using the translation proxy's pages. The pages are in English; sign in with the shared password. A guide for reviewers (customers and linguists using the Chrome extension) follows with the extension.

## Tenants

A **tenant** is one Supertext API key that sent translations through the proxy. The proxy never stores the key itself, only its SHA-256 fingerprint, so a tenant first appears as *Key 114afd430f…*. The *Tenants* tab lists them with their target languages, how many texts the memory holds, how many were reviewed, the last request and which plugin sent it.

![Tenants list with one tenant, its languages and counts](images/tenants.png)

Open a tenant to give it a **label** (the customer's name and site) and notes. Below is its **translation memory**: every text the plugin sent, per language pair, with the translation the proxy serves and its status:

- **AI**: the AI translation as Supertext first returned it. The proxy serves it every time the same text comes again, so a text never changes by itself.
- **corrected**: a reviewer corrected it; the AI translation is shown underneath. The proxy serves the correction from now on.
- **approved**: a reviewer confirmed the served translation.

*Requests* counts how often the plugin asked for the text. *Newer AI answer* appears when a whole page went to Supertext again and Supertext would now translate a known text differently; the proxy still serves the stored one. Filter by language and status or search the source and translation.

![A tenant's translation memory with one corrected text](images/tenant-memory.png)

## Review sites and links

To let people review a customer's website, add it under **Review sites** → *New review site*:

- **Tenant**: the API key its plugin uses (label tenants first, so you find the right one).
- **Site address**: e.g. `https://www.alpenblick.example.ch`.
- **Source language** (Supertext code, e.g. `en`) and its **path prefix** (`/en/`), and one line per **target language** with its prefix (`de-CH /de/`). The extension uses the prefixes to open the matching page in the other language. Leave them empty when the site's URLs don't follow a prefix scheme.

![A review site with two links and its settings](images/site-links.png)

On the site's page, **create a review link** per person or team: target language, role (*Customer* or *Supertext linguist*), who it is for, and how many days it is valid (1–365). The table shows each link's address to send (`https://…/review#…`; the part after `#` is the key, keep the whole link), when it was last used and how many corrections came through it. **Revoke** stops a link at once. Every correction records the reviewer's name, role and link.

A review link opens a page that explains how to start reviewing:

![The page a review link opens](images/review-link.png)

Anyone who has a link can change that site's translations in that language until it expires, so send links only to the people who should review, and revoke links you no longer need.

## How corrections reach the website

The proxy serves a correction the next time the plugin asks for that text: when an editor translates the page again, or the plugin translates it again on its own. Corrections don't yet appear on the website by themselves; pushing them to the CMS directly is on the roadmap.
