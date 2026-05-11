import { safeImport } from '../safeImport.js';
import type { AppliedRow, DbCredentials, MigrationsTableRef } from '../types.js';

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

interface MysqlConnection {
  execute: (sql: string, params?: unknown[]) => Promise<[Array<Record<string, unknown>>, unknown]>;
  end: () => Promise<void>;
}

interface MysqlModule {
  createConnection: (cfg: Record<string, unknown>) => Promise<MysqlConnection>;
  default?: { createConnection: MysqlModule['createConnection'] };
}

export async function readApplied(
  creds: DbCredentials,
  table: MigrationsTableRef,
): Promise<AppliedRow[]> {
  const mod = await safeImport<MysqlModule>('mysql2/promise', 'npm i mysql2');
  const createConnection = (mod.createConnection ?? mod.default?.createConnection)!;

  const cfg: Record<string, unknown> = creds.url
    ? { uri: creds.url }
    : { ...creds };
  const conn = await createConnection(cfg);
  try {
    const schemaPrefix = table.schema ? `${quoteIdent(table.schema)}.` : '';
    // Probe table existence via INFORMATION_SCHEMA; tolerate missing table.
    const [exists] = await conn.execute(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? LIMIT 1`,
      [table.schema ?? null, table.table],
    );
    if (!Array.isArray(exists) || exists.length === 0) return [];
    const [rows] = await conn.execute(
      `SELECT hash, created_at FROM ${schemaPrefix}${quoteIdent(table.table)} ORDER BY created_at ASC, id ASC`,
    );
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      hash: String(r.hash),
      createdAt: Number(r.created_at),
    }));
  } finally {
    await conn.end();
  }
}
