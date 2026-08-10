import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// numeric(5,2) arrives as a string by default; completion percentages are small
// enough that a float is exact for display purposes.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export const sql = pool.query.bind(pool);

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Applies any migration files not yet recorded, in filename order, each in its
 * own transaction. Safe to run on every boot.
 */
export async function migrate(): Promise<void> {
  await sql(`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await sql<{ name: string }>('select name from schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  for (const file of files) {
    if (applied.has(file)) continue;
    const ddl = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(ddl);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
      console.log(`[db] applied migration ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}

/** Blocks until Postgres accepts connections — the app container starts first. */
export async function waitForDatabase(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await sql('select 1');
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
