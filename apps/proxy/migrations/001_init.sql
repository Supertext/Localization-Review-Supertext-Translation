-- Supertext translation proxy: tenants, translation memory, jobs, review sites and links.

-- A tenant is one Supertext API key, known only by its SHA-256 fingerprint (hex).
CREATE TABLE tenants (
  fingerprint     text PRIMARY KEY CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  label           text NOT NULL DEFAULT '',
  notes           text NOT NULL DEFAULT '',
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  -- The integration's User-Agent on its latest request (plugin name and version).
  last_user_agent text NOT NULL DEFAULT ''
);

-- The translation memory: one row per tenant, language pair, politeness and source segment.
CREATE TABLE segments (
  id               bigserial PRIMARY KEY,
  tenant           text NOT NULL REFERENCES tenants (fingerprint) ON DELETE CASCADE,
  -- '' when the integration let Supertext detect the source language.
  source_lang      text NOT NULL,
  target_lang      text NOT NULL,
  -- '' (default), 'more' or 'less'.
  politeness       text NOT NULL,
  -- SHA-256 (hex) of tenant, languages, politeness and the normalized source HTML.
  key              text NOT NULL UNIQUE,
  source_html      text NOT NULL,
  source_text      text NOT NULL,
  -- The AI translation as first received: what the proxy serves until a human corrects it.
  ai_html          text NOT NULL,
  -- Supertext's answer the last time it translated this segment again (whole-document uploads).
  ai_latest_html   text,
  ai_latest_at     timestamptz,
  -- The human correction, if any. The proxy serves it instead of the AI translation.
  correction_html  text,
  -- Plain normalized text of what the proxy serves (correction or AI), for matching page texts.
  served_text      text NOT NULL,
  status           text NOT NULL DEFAULT 'ai' CHECK (status IN ('ai', 'corrected', 'approved')),
  hits             integer NOT NULL DEFAULT 0,
  user_agent       text NOT NULL DEFAULT '',
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX segments_served_text ON segments (tenant, target_lang, md5(served_text));
CREATE INDEX segments_source_text ON segments (tenant, target_lang, md5(source_text));
CREATE INDEX segments_browse ON segments (tenant, target_lang, last_seen_at DESC);

-- Everything that happened to a segment: AI translations, corrections, approvals, comments.
CREATE TABLE segment_events (
  id          bigserial PRIMARY KEY,
  segment_id  bigint NOT NULL REFERENCES segments (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('ai', 'correction', 'approval', 'comment')),
  html        text,
  comment     text,
  reviewer    text,
  role        text CHECK (role IN ('customer', 'linguist')),
  link_id     bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX segment_events_segment ON segment_events (segment_id, created_at);

-- One upload of an integration (the proxy's file_id). Kept 24 hours, like Supertext's files.
CREATE TABLE jobs (
  id                text PRIMARY KEY,
  tenant            text NOT NULL REFERENCES tenants (fingerprint) ON DELETE CASCADE,
  source_lang       text NOT NULL,
  target_lang       text NOT NULL,
  politeness        text NOT NULL,
  -- 'local': every segment came from the memory; 'reduced': only the missing segments went to
  -- Supertext; 'full': the whole document went to Supertext (it has text outside segments).
  mode              text NOT NULL CHECK (mode IN ('local', 'reduced', 'full')),
  original_html     text NOT NULL,
  -- [{ "id": "<data-st-id>", "key": "<segment key>" | null }] in document order (null: blank segment).
  segments          jsonb NOT NULL,
  upstream_file_id  text,
  -- translating, done, error, limit_exceeded, deleted
  status            text NOT NULL,
  -- Supertext's translated document in 'full' mode (the base of the answer).
  upstream_html     text,
  user_agent        text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_created ON jobs (created_at);

-- A website whose translations are reviewed, belonging to one tenant.
CREATE TABLE review_sites (
  id             bigserial PRIMARY KEY,
  tenant         text NOT NULL REFERENCES tenants (fingerprint) ON DELETE CASCADE,
  name           text NOT NULL,
  origin         text NOT NULL,
  source_lang    text,
  source_prefix  text,
  -- { "<target_lang>": "<path prefix>" }, e.g. { "fr-CH": "/fr/" }
  target_prefixes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- A review link: one site, one target language, one role. The token is "<id>.<hmac>".
CREATE TABLE review_links (
  id          bigserial PRIMARY KEY,
  site_id     bigint NOT NULL REFERENCES review_sites (id) ON DELETE CASCADE,
  target_lang text NOT NULL,
  role        text NOT NULL CHECK (role IN ('customer', 'linguist')),
  label       text NOT NULL DEFAULT '',
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  last_used_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
