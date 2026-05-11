import { safeImport } from '../safeImport.js';
import type { AppliedRow, DbCredentials, MigrationsTableRef } from '../types.js';

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function readApplied(
  creds: DbCredentials,
  table: MigrationsTableRef,
): Promise<AppliedRow[]> {
  const pgMod = await safeImport<{ default?: { Client: new (cfg: unknown) => unknown }; Client?: new (cfg: unknown) => unknown }>(
    'pg',
    'npm i pg',
  );
  const Client = (pgMod.default?.Client ?? pgMod.Client) as new (cfg: unknown) => {
    connect: () => Promise<void>;
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
    end: () => Promise<void>;
  };

  const cfg: Record<string, unknown> = creds.url
    ? { connectionString: creds.url }
    : { ...creds };
  const client = new Client(cfg);

  await client.connect();
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
