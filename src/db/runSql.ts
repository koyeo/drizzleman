import { readFileSync } from 'node:fs';
import { safeImport } from '../safeImport.js';

interface PgClient {
  connect: () => Promise<void>;
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  end: () => Promise<void>;
}

async function connect(url: string): Promise<PgClient> {
  const pgMod = await safeImport<{
    default?: { Client: new (cfg: unknown) => unknown };
    Client?: new (cfg: unknown) => unknown;
  }>('pg', 'npm i pg');
  const Client = (pgMod.default?.Client ?? pgMod.Client) as new (cfg: unknown) => PgClient;
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

export interface RunSqlSuccess {
  ok: true;
  byteCount: number;
}
export interface RunSqlFailure {
  ok: false;
  // Surface what we can: pg error message, the SQLSTATE code if present, and
  // (if the driver gave a position) the snippet of failing SQL around it.
  error: string;
  code?: string;
  position?: number;
  snippet?: string;
}
export type RunSqlResult = RunSqlSuccess | RunSqlFailure;

// Execute a SQL file against a postgres URL using pg.Client's Simple Query
// protocol — the whole file goes in one round-trip, postgres splits on `;`
// and runs each statement in autocommit. This is what `psql -f file.sql`
// does internally; using pg.Client keeps the dependency footprint to just
// the `pg` package drizzleman already uses (no separate psql binary).
//
// Behaviour notes:
// - Statements like `CREATE EXTENSION`, `CREATE DATABASE`, `ALTER TYPE …
//   ADD VALUE` that postgres refuses inside a transaction work fine here
//   because autocommit means no implicit BEGIN.
// - On error, pg returns the position (byte offset) of the failing statement
//   in the input — we use that to slice ~120 chars of surrounding SQL into
//   `snippet` for the user's terminal.
export async function runSqlFile(dbUrl: string, sqlFile: string): Promise<RunSqlResult> {
  const sql = readFileSync(sqlFile, 'utf8');
  return runSqlString(dbUrl, sql);
}

export async function runSqlString(dbUrl: string, sql: string): Promise<RunSqlResult> {
  let client: PgClient;
  try {
    client = await connect(dbUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `connection failed: ${msg}` };
  }
  try {
    await client.query(sql);
    return { ok: true, byteCount: Buffer.byteLength(sql, 'utf8') };
  } catch (err) {
    const e = err as { message?: string; code?: string; position?: string | number };
    const message = e.message ?? String(err);
    const code = e.code;
    let position: number | undefined;
    let snippet: string | undefined;
    if (e.position != null) {
      const p = typeof e.position === 'string' ? parseInt(e.position, 10) : e.position;
      if (Number.isFinite(p)) {
        position = p;
        // pg position is 1-based byte offset. Slice ~120 chars around it.
        const start = Math.max(0, p - 60);
        const end = Math.min(sql.length, p + 60);
        snippet = sql.slice(start, end).replace(/\s+/g, ' ').trim();
      }
    }
    return { ok: false, error: message, code, position, snippet };
  } finally {
    await client.end().catch(() => {
      /* ignore close errors */
    });
  }
}
