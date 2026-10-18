// Creates the database (when REVIEW_DB_NAME is set) and applies migrations/*.sql in order.
// Runs before every start; safe to run again (applied migrations are recorded in schema_migrations).
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';
import { databaseUrls } from '../src/lib/db-url.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { url, adminUrl, name } = databaseUrls();

if (adminUrl && name) {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    const [row] = await admin`SELECT 1 AS ok FROM pg_database WHERE datname = ${name}`;
    if (!row) {
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      console.log(`migrate: created database ${name}`);
    }
  } finally {
    await admin.end();
  }
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  await sql`SELECT pg_advisory_lock(727101)`;
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const done = new Set((await sql`SELECT name FROM schema_migrations`).map((r) => r.name));
  const files = (await readdir(path.join(root, 'migrations'))).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const body = await readFile(path.join(root, 'migrations', file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    console.log(`migrate: applied ${file}`);
  }
  console.log('migrate: database is up to date');
} finally {
  await sql`SELECT pg_advisory_unlock(727101)`.catch(() => {});
  await sql.end();
}
