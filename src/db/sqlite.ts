import path from 'node:path';
import { safeImport } from '../safeImport.js';
import type { AppliedRow, DbCredentials, MigrationsTableRef } from '../types.js';

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface SqliteStatement {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
}

interface SqliteDatabase {
  prepare: (sql: string) => SqliteStatement;
  exec: (sql: string) => unknown;
  transaction: <T>(fn: () => T) => () => T;
  close: () => void;
}

type SqliteCtor = new (file: string, opts?: Record<string, unknown>) => SqliteDatabase;

async function loadCtor(): Promise<SqliteCtor> {
  const mod = await safeImport<{ default: SqliteCtor }>('better-sqlite3', 'npm i better-sqlite3');
  return mod.default;
}

function resolveFile(creds: DbCredentials): string {
  return typeof creds.url === 'string' && creds.url
    ? path.resolve(process.cwd(), creds.url)
    : ':memory:';
}

export async function readApplied(
  creds: DbCredentials,
  table: MigrationsTableRef,
): Promise<AppliedRow[]> {
  const Database = await loadCtor();
  const db = new Database(resolveFile(creds), { readonly: true, fileMustExist: false });
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

export async function assertSchemaDbEmpty(_creds: DbCredentials): Promise<void> {
  throw new Error('assertSchemaDbEmpty is not implemented for sqlite yet; only postgresql is supported.');
}

export async function appendAppliedHash(
  _creds: DbCredentials,
  _table: MigrationsTableRef,
  _entry: { hash: string; createdAt: number },
): Promise<{ inserted: boolean }> {
  throw new Error('appendAppliedHash is not implemented for sqlite; rebase / manual journal entries are postgres-only.');
}

export async function resetAppliedToRebase(
  creds: DbCredentials,
  table: MigrationsTableRef,
  rebase: { hash: string; createdAt: number },
  backupTable: string | null,
): Promise<void> {
  const Database = await loadCtor();
  const db = new Database(resolveFile(creds), { fileMustExist: false });
  try {
    const qTable = quoteIdent(table.table);
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${qTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL,
        created_at INTEGER
      )`,
    );

    if (backupTable) {
      const exists = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
        .get(backupTable);
      if (exists) {
        throw new Error(`backup table ${backupTable} already exists; refusing to overwrite`);
      }
      const qBackup = quoteIdent(backupTable);
      db.exec(`CREATE TABLE ${qBackup} AS SELECT * FROM ${qTable}`);
    }

    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM ${qTable}`).run();
      db.prepare(`INSERT INTO ${qTable} (hash, created_at) VALUES (?, ?)`).run(
        rebase.hash,
        rebase.createdAt,
      );
    });
    tx();
  } finally {
    db.close();
  }
}
