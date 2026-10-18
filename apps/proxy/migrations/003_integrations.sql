-- Which plugins use the proxy: one row per tenant and plugin (from the User-Agent the SDK sends,
-- e.g. "supertext-sdk-php Typo3-Supertext-Translation/0.6.0").
CREATE TABLE integrations (
  tenant          text NOT NULL REFERENCES tenants (fingerprint) ON DELETE CASCADE,
  -- The plugin's name (its repo name), or '' when the User-Agent names none.
  plugin          text NOT NULL,
  plugin_version  text NOT NULL DEFAULT '',
  -- The SDK the plugin uses: php, typescript, python, dotnet, java, or ''.
  sdk             text NOT NULL DEFAULT '',
  user_agent      text NOT NULL DEFAULT '',
  -- Key checks (GET features), uploads, and uploads answered from the memory alone.
  key_checks      integer NOT NULL DEFAULT 0,
  uploads         integer NOT NULL DEFAULT 0,
  memory_answers  integer NOT NULL DEFAULT 0,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant, plugin)
);
CREATE INDEX integrations_plugin ON integrations (plugin, last_seen_at DESC);

