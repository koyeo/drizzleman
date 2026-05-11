import path from 'node:path';
import { safeImport } from '../safeImport.js';
import type { AppliedRow, DbCredentials, MigrationsTableRef } from '../types.js';

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface SqliteDatabase {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
  };
  close: () => void;
}

type SqliteCtor = new (file: string, opts?: Record<string, unknown>) => SqliteDatabase;

export async function readApplied(
  creds: DbCredentials,
  table: MigrationsTableRef,
): Promise<AppliedRow[]> {
  const mod = await safeImport<{ default: SqliteCtor }>('better-sqlite3', 'npm i better-sqlite3');
  const Database = mod.default;

  const file = typeof creds.url === 'string' && creds.url
    ? path.resolve(process.cwd(), creds.url)
    : ':memory:';
  const db = new Database(file, { readonly: true, fileMustExist: false });
  try {
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table.table);
    if (!exists) return [];
    const rows = db
      .prepare(`SELECT hash, created_at FROM ${quoteIdent(table.table)} ORDER BY created_at ASC, id ASC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      hash: String(r.hash),
      createdAt: Number(r.created_at),
    }));
  } finally {
    db.close();
  }
}
