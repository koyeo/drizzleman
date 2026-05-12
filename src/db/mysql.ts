import { safeImport } from '../safeImport.js';
import type { AppliedRow, DbCredentials, MigrationsTableRef } from '../types.js';

function quoteIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

interface MysqlConnection {
  execute: (sql: string, params?: unknown[]) => Promise<[Array<Record<string, unknown>>, unknown]>;
  query: (sql: string, params?: unknown[]) => Promise<[Array<Record<string, unknown>>, unknown]>;
  beginTransaction: () => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  end: () => Promise<void>;
}

interface MysqlModule {
  createConnection: (cfg: Record<string, unknown>) => Promise<MysqlConnection>;
  default?: { createConnection: MysqlModule['createConnection'] };
}

async function connect(creds: DbCredentials): Promise<MysqlConnection> {
  const mod = await safeImport<MysqlModule>('mysql2/promise', 'npm i mysql2');
  const createConnection = (mod.createConnection ?? mod.default?.createConnection)!;
  const cfg: Record<string, unknown> = creds.url ? { uri: creds.url } : { ...creds };
  return createConnection(cfg);
}

export async function readApplied(
  creds: DbCredentials,
  table: MigrationsTableRef,
): Promise<AppliedRow[]> {
  const conn = await connect(creds);
  try {
    const schemaPrefix = table.schema ? `${quoteIdent(table.schema)}.` : '';
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

export async function assertSchemaDbEmpty(_creds: DbCredentials): Promise<void> {
  throw new Error('assertSchemaDbEmpty is not implemented for mysql yet; only postgresql is supported.');
}

export async function resetAppliedToBaseline(
  creds: DbCredentials,
  table: MigrationsTableRef,
  baseline: { hash: string; createdAt: number },
  backupTable: string | null,
): Promise<void> {
  const conn = await connect(creds);
  try {
    const schemaPrefix = table.schema ? `${quoteIdent(table.schema)}.` : '';
    const qTable = quoteIdent(table.table);
    await conn.query(
      `CREATE TABLE IF NOT EXISTS ${schemaPrefix}${qTable} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        hash TEXT NOT NULL,
        created_at BIGINT
      )`,
    );

    if (backupTable) {
      const qBackup = quoteIdent(backupTable);
      const [exists] = await conn.execute(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ? LIMIT 1`,
        [table.schema ?? null, backupTable],
      );
      if (Array.isArray(exists) && exists.length > 0) {
        throw new Error(`backup table ${table.schema ? `${table.schema}.` : ''}${backupTable} already exists; refusing to overwrite`);
      }
      await conn.query(`CREATE TABLE ${schemaPrefix}${qBackup} AS SELECT * FROM ${schemaPrefix}${qTable}`);
    }

    await conn.beginTransaction();
    try {
      await conn.query(`TRUNCATE TABLE ${schemaPrefix}${qTable}`);
      await conn.execute(
        `INSERT INTO ${schemaPrefix}${qTable} (hash, created_at) VALUES (?, ?)`,
        [baseline.hash, baseline.createdAt],
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    }
  } finally {
    await conn.end();
  }
}
