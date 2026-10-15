import { Client } from 'pg';
import runner from 'node-pg-migrate';
import { resolve } from 'path';
import { ADMIN_DATABASE_URL, TEST_DATABASE_URL } from './testEnv';

/**
 * Runs once before the whole test suite: create the isolated test database (if
 * absent) and migrate it to the latest schema. Works identically locally and in
 * CI (where TEST_* env vars point at the service containers).
 */
export default async function setup(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE webhook_test');
  } catch (err) {
    // 42P04 = database already exists; anything else is a real error.
    if ((err as { code?: string }).code !== '42P04') throw err;
  } finally {
    await admin.end();
  }

  await runner({
    databaseUrl: TEST_DATABASE_URL,
    dir: resolve(process.cwd(), 'migrations'),
    direction: 'up',
    count: Infinity,
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
}
