import { safeImport } from '../safeImport.js';
import type { AppliedRow, DbCredentials, MigrationsTableRef } from '../types.js';

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface PgClient {
  connect: () => Promise<void>;
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  end: () => Promise<void>;
}

async function connect(creds: DbCredentials): Promise<PgClient> {
  const pgMod = await safeImport<{
    default?: { Client: new (cfg: unknown) => unknown };
    Client?: new (cfg: unknown) => unknown;
  }>('pg', 'npm i pg');
  const Client = (pgMod.default?.Client ?? pgMod.Client) as new (cfg: unknown) => PgClient;
  const cfg: Record<string, unknown> = creds.url ? { connectionString: creds.url } : { ...creds };
  const client = new Client(cfg);
  await client.connect();
  return client;
}

export async function readApplied(
  creds: DbCredentials,
  table: MigrationsTableRef,
): Promise<AppliedRow[]> {
  const client = await connect(creds);
  try {
    const schema = table.schema ?? 'drizzle';
    const tableCheck = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 LIMIT 1`,
      [schema, table.table],
    );
    if ((tableCheck.rowCount ?? 0) === 0) return [];
    const res = await client.query(
      `SELECT hash, created_at FROM ${quoteIdent(schema)}.${quoteIdent(table.table)} ORDER BY created_at ASC, id ASC`,
    );
    return res.rows.map((r) => ({
      hash: String(r.hash),
      createdAt: Number(r.created_at),
    }));
  } finally {
    await client.end();
  }
}

const PG_SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema'];

export async function assertSchemaDbEmpty(creds: DbCredentials): Promise<void> {
  const client = await connect(creds);
  try {
    const res = await client.query(
      `SELECT table_schema, table_name
       FROM information_schema.tables
       WHERE table_schema NOT IN (${PG_SYSTEM_SCHEMAS.map((_, i) => `$${i + 1}`).join(', ')})
         AND table_schema NOT LIKE 'pg_toast%'
         AND table_schema NOT LIKE 'pg_temp_%'
         AND table_schema NOT LIKE 'pg_toast_temp_%'
       ORDER BY table_schema, table_name
       LIMIT 20`,
      PG_SYSTEM_SCHEMAS,
    );
    if ((res.rowCount ?? 0) > 0) {
      const sample = res.rows
        .map((r) => `${String(r.table_schema)}.${String(r.table_name)}`)
        .join(', ');
      const more = (res.rowCount ?? 0) >= 20 ? ' (showing first 20)' : '';
      throw new Error(
        `schema DB is not empty — found ${res.rowCount} table(s)${more}: ${sample}. Drop everything in non-system schemas (including drizzle.__drizzle_migrations) and retry.`,
      );
    }
  } finally {
    await client.end();
  }
}

export async function resetAppliedToRebase(
  creds: DbCredentials,
  table: MigrationsTableRef,
  rebase: { hash: string; createdAt: number },
  backupTable: string | null,
): Promise<void> {
  const client = await connect(creds);
  try {
    const schema = table.schema ?? 'drizzle';
    const qSchema = quoteIdent(schema);
    const qTable = quoteIdent(table.table);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${qSchema}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${qSchema}.${qTable} (
        id SERIAL PRIMARY KEY,
        hash TEXT NOT NULL,
        created_at BIGINT
      )`,
    );

    if (backupTable) {
      const qBackup = quoteIdent(backupTable);
      const exists = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 LIMIT 1`,
        [schema, backupTable],
      );
      if ((exists.rowCount ?? 0) > 0) {
        throw new Error(`backup table ${schema}.${backupTable} already exists; refusing to overwrite`);
      }
      await client.query(`CREATE TABLE ${qSchema}.${qBackup} AS SELECT * FROM ${qSchema}.${qTable}`);
    }

    await client.query('BEGIN');
    try {
      await client.query(`TRUNCATE TABLE ${qSchema}.${qTable} RESTART IDENTITY`);
      await client.query(
        `INSERT INTO ${qSchema}.${qTable} (hash, created_at) VALUES ($1, $2)`,
        [rebase.hash, rebase.createdAt],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    await client.end();
  }
}
