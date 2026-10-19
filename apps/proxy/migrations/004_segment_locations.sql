-- Where each segment sits in an integration's content, so corrections can reach the CMS
-- without the content being sent again: the segment's data-st-id per tenant, plugin, language
-- pair and politeness, and the translation the integration last received for it. A segment
-- whose served translation (a correction) differs from that is a pending correction.
CREATE TABLE segment_locations (
  id              bigserial PRIMARY KEY,
  tenant          text NOT NULL REFERENCES tenants (fingerprint) ON DELETE CASCADE,
  -- The plugin's name from the User-Agent (without version), '' when it names none:
  -- two plugins on the same key never see each other's ids.
  plugin          text NOT NULL,
  source_lang     text NOT NULL,
  target_lang     text NOT NULL,
  politeness      text NOT NULL,
  -- The data-st-id the integration gave the segment (its own reference to the field).
  st_id           text NOT NULL,
  -- The segment last sent under this id (the source text may change over time).
  segment_id      bigint NOT NULL REFERENCES segments (id) ON DELETE CASCADE,
  -- What the integration last received for it: downloaded with a translation, or acknowledged.
  delivered_html  text NOT NULL,
  delivered_at    timestamptz NOT NULL DEFAULT now(),
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant, plugin, source_lang, target_lang, politeness, st_id)
);
CREATE INDEX segment_locations_segment ON segment_locations (segment_id);
CREATE INDEX segment_locations_tenant ON segment_locations (tenant, plugin, target_lang);
