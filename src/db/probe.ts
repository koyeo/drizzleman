import { safeImport } from '../safeImport.js';
import type { DbCredentials, Dialect } from '../types.js';

export interface DbProbe {
  // Engine self-identifier, parsed from `version()` first word.
  // Stock postgres → "PostgreSQL"; CockroachDB / YugabyteDB / etc → their own name.
  // mysql → "MySQL" or "MariaDB"; sqlite → "SQLite".
  engine: string;
  // Full version() string, kept verbatim for the user to eyeball.
  versionString: string;
  majorVersion: number;
  minorVersion: number;
  patchVersion: number;
}

// First identifier-looking token of a version() string ("PostgreSQL 16.2 ..." → "PostgreSQL").
function extractEngineName(versionString: string): string {
  const m = versionString.match(/^([A-Za-z][A-Za-z0-9]*)/);
  return m ? m[1]! : 'unknown';
}

// Postgres `server_version_num` is the authoritative integer version:
//   PG 10+ format: MMNNNN  (160002 = 16.0.2, 150004 = 15.0.4)
//   PG < 10 format: MMNNPP (90602 = 9.6.2) — but drizzle-kit requires PG ≥ 13 in practice.
function parsePgServerVersionNum(n: number): {
  major: number;
  minor: number;
  patch: number;
} {
  if (n >= 100000) {
    return { major: Math.floor(n / 10000), minor: Math.floor((n % 10000) / 100), patch: n % 100 };
  }
  return { major: Math.floor(n / 10000), minor: Math.floor((n % 10000) / 100), patch: n % 100 };
}

function parseSemverTriple(s: string): { major: number; minor: number; patch: number } {
  const m = s.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return { major: 0, minor: 0, patch: 0 };
  return {
    major: parseInt(m[1]!, 10),
    minor: parseInt(m[2]!, 10),
    patch: m[3] ? parseInt(m[3], 10) : 0,
  };
}

interface PgClientShape {
  connect: () => Promise<void>;
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  end: () => Promise<void>;
}

async function probePostgres(creds: DbCredentials): Promise<DbProbe> {
  const pgMod = await safeImport<{
    default?: { Client: new (cfg: unknown) => unknown };
    Client?: new (cfg: unknown) => unknown;
  }>('pg', 'npm i pg');
  const Client = (pgMod.default?.Client ?? pgMod.Client) as new (cfg: unknown) => PgClientShape;
  const cfg: Record<string, unknown> = creds.url ? { connectionString: creds.url } : { ...creds };
  const client = new Client(cfg);
  await client.connect();
  try {
    const verRes = await client.query(`SELECT version() AS v`);
    const versionString = String(verRes.rows[0]?.v ?? '');
    const engine = extractEngineName(versionString);

    let major = 0;
    let minor = 0;
    let patch = 0;
    try {
      const numRes = await client.query(
        `SELECT current_setting('server_version_num')::int AS n`,
      );
      const n = Number(numRes.rows[0]?.n ?? 0);
      const parsed = parsePgServerVersionNum(n);
      major = parsed.major;
      minor = parsed.minor;
      patch = parsed.patch;
    } catch {
      // Fallback for non-standard engines that don't expose server_version_num.
      const tail = versionString.replace(/^[A-Za-z][A-Za-z0-9]*\s*v?/, '');
      const parsed = parseSemverTriple(tail);
      major = parsed.major;
      minor = parsed.minor;
      patch = parsed.patch;
    }

    return { engine, versionString, majorVersion: major, minorVersion: minor, patchVersion: patch };
  } finally {
    await client.end();
  }
}

interface MysqlConnectionShape {
  execute: (sql: string, params?: unknown[]) => Promise<[Array<Record<string, unknown>>, unknown]>;
  end: () => Promise<void>;
}

async function probeMysql(creds: DbCredentials): Promise<DbProbe> {
  const mod = await safeImport<{
    createConnection: (cfg: Record<string, unknown>) => Promise<MysqlConnectionShape>;
    default?: { createConnection: (cfg: Record<string, unknown>) => Promise<MysqlConnectionShape> };
  }>('mysql2/promise', 'npm i mysql2');
  const createConnection = (mod.createConnection ?? mod.default?.createConnection)!;
  const cfg: Record<string, unknown> = creds.url ? { uri: creds.url } : { ...creds };
  const conn = await createConnection(cfg);
  try {
    const [verRows] = await conn.execute(`SELECT VERSION() AS v`);
    const versionString = String((verRows as Array<Record<string, unknown>>)[0]?.v ?? '');
    let comment = '';
    try {
      const [cmtRows] = await conn.execute(`SELECT @@version_comment AS c`);
      comment = String((cmtRows as Array<Record<string, unknown>>)[0]?.c ?? '');
    } catch {
      // some servers restrict access; fall through with empty comment
    }
    const isMaria = /mariadb/i.test(comment) || /mariadb/i.test(versionString);
    const engine = isMaria ? 'MariaDB' : 'MySQL';
    const { major, minor, patch } = parseSemverTriple(versionString);
    return {
      engine,
      versionString,
      majorVersion: major,
      minorVersion: minor,
      patchVersion: patch,
    };
  } finally {
    await conn.end();
  }
}

interface SqliteDbShape {
  prepare: (sql: string) => { get: () => unknown };
  close: () => void;
}

async function probeSqlite(creds: DbCredentials): Promise<DbProbe> {
  const mod = await safeImport<{ default: new (file: string, opts?: Record<string, unknown>) => SqliteDbShape }>(
    'better-sqlite3',
    'npm i better-sqlite3',
  );
  const file = typeof creds.url === 'string' && creds.url ? creds.url : ':memory:';
  // `:memory:` rejects { readonly: true } (better-sqlite3 errors with
  // "In-memory/temporary databases cannot be readonly"). Use defaults for
  // :memory:; for real files prefer readonly to keep probe non-destructive.
  const opts = file === ':memory:' ? {} : { readonly: true, fileMustExist: false };
  const db = new mod.default(file, opts);
  try {
    const row = db.prepare(`SELECT sqlite_version() AS v`).get() as { v?: string } | undefined;
    const versionString = String(row?.v ?? '');
    const { major, minor, patch } = parseSemverTriple(versionString);
    return {
      engine: 'SQLite',
      versionString,
      majorVersion: major,
      minorVersion: minor,
      patchVersion: patch,
    };
  } finally {
    db.close();
  }
}

export async function probeDb(dialect: Dialect, creds: DbCredentials): Promise<DbProbe> {
  switch (dialect) {
    case 'postgresql':
      return probePostgres(creds);
    case 'mysql':
      return probeMysql(creds);
    case 'sqlite':
      return probeSqlite(creds);
    default: {
      const _exhaustive: never = dialect;
      throw new Error(`unsupported dialect for probe: ${String(_exhaustive)}`);
    }
  }
}
