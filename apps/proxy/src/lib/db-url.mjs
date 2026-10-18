// Shared by scripts/migrate.mjs and the app, so both always reach the same database.
// DATABASE_URL points at the Postgres server; REVIEW_DB_NAME (optional) selects this app's
// own database on a shared server (Railway). Without it, the database in DATABASE_URL is used.

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ url: string, adminUrl: string | null, name: string | null }}
 */
export function databaseUrls(env = process.env) {
  const base = env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set.');
  const name = env.REVIEW_DB_NAME || null;
  if (!name) return { url: base, adminUrl: null, name: null };
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error('REVIEW_DB_NAME may contain only lower-case letters, digits and underscores.');
  }
  const u = new URL(base);
  const admin = new URL(base);
  u.pathname = `/${name}`;
  return { url: u.toString(), adminUrl: admin.toString(), name };
}
