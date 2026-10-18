import postgres from 'postgres';
import { databaseUrls } from './db-url.mjs';

export type Sql = postgres.Sql;

const globalForDb = globalThis as unknown as { reviewSql?: Sql };

/** The shared connection pool (one per process). */
export function db(): Sql {
  if (!globalForDb.reviewSql) {
    globalForDb.reviewSql = postgres(databaseUrls().url, { max: 10, idle_timeout: 30, onnotice: () => {} });
  }
  return globalForDb.reviewSql;
}
