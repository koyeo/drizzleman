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
  // Canonical release label as the engine itself writes it: PG 10+ is
  // "major.patch" (no separate minor — server_version_num is MAJOR*10000+PATCH);
  // PG < 10 / mysql / sqlite are "major.minor.patch".
  releaseLabel: string;
}

// First identifier-looking token of a version() string ("PostgreSQL 16.2 ..." → "PostgreSQL").
function extractEngineName(versionString: string): string {
  const m = versionString.match(/^([A-Za-z][A-Za-z0-9]*)/);
  return m ? m[1]! : 'unknown';
}

// Postgres `server_version_num` is the authoritative integer version:
//   PG 10+ format: MAJOR * 10000 + PATCH  (180002 = 18.2, 160002 = 16.2). There
//     is no "minor" between major and patch since the PG10 numbering reform —
//     so we keep `minor = 0` for these and report releaseLabel as "MAJOR.PATCH".
//   PG < 10 format: MAJOR * 10000 + MINOR * 100 + PATCH  (90602 = 9.6.2). Kept
//     for completeness; drizzle-kit itself requires PG ≥ 13 in practice.
function parsePgServerVersionNum(n: number): {
  major: number;
  minor: number;
  patch: number;
  releaseLabel: string;
} {
  if (n >= 100000) {
    const major = Math.floor(n / 10000);
    const patch = n % 100;
    return { major, minor: 0, patch, releaseLabel: `${major}.${patch}` };
  }
  const major = Math.floor(n / 10000);
  const minor = Math.floor((n % 10000) / 100);
  const patch = n % 100;
  return { major, minor, patch, releaseLabel: `${major}.${minor}.${patch}` };
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
    let releaseLabel = '';
    try {
      const numRes = await client.query(
        `SELECT current_setting('server_version_num')::int AS n`,
      );
      const n = Number(numRes.rows[0]?.n ?? 0);
      const parsed = parsePgServerVersionNum(n);
      major = parsed.major;
      minor = parsed.minor;
      patch = parsed.patch;
      releaseLabel = parsed.releaseLabel;
    } catch {
      // Fallback for non-standard engines that don't expose server_version_num.
      const tail = versionString.replace(/^[A-Za-z][A-Za-z0-9]*\s*v?/, '');
      const parsed = parseSemverTriple(tail);
      major = parsed.major;
      minor = parsed.minor;
      patch = parsed.patch;
      releaseLabel = `${major}.${minor}.${patch}`;
    }

    return {
      engine,
      versionString,
      majorVersion: major,
      minorVersion: minor,
      patchVersion: patch,
      releaseLabel,
    };
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
      releaseLabel: `${major}.${minor}.${patch}`,
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
      releaseLabel: `${major}.${minor}.${patch}`,
    };
  } finally {
    db.close();
  }
}

// Identifies a standalone index (not backing any PK/UNIQUE constraint) as
// seen by Postgres itself. Useful as a fallback for drizzle-kit introspect
// when it silently drops indexes from its output (a known 0.31.x bug:
// some `<table>_<col>_key`-style unique indexes never make it into the
// introspect SQL / snapshot, leaving FKs that reference them un-applyable).
export interface StandaloneIndexInfo {
  schemaName: string;
  tableName: string;
  indexName: string;
  // pg_get_indexdef(oid) output — canonical CREATE INDEX statement (no `;`).
  indexDef: string;
}

export async function listStandalonePgIndexes(
  creds: DbCredentials,
): Promise<StandaloneIndexInfo[]> {
  const pgMod = await safeImport<{
    default?: { Client: new (cfg: unknown) => unknown };
    Client?: new (cfg: unknown) => unknown;
  }>('pg', 'npm i pg');
  const Client = (pgMod.default?.Client ?? pgMod.Client) as new (cfg: unknown) => PgClientShape;
  const cfg: Record<string, unknown> = creds.url ? { connectionString: creds.url } : { ...creds };
  const client = new Client(cfg);
  await client.connect();
  try {
    // The LEFT JOIN must restrict to constraint types `p` (PRIMARY KEY) and
    // `u` (UNIQUE). Without that restriction, FK constraints — whose
    // `conindid` points to the unique index on the REFERENCED table — would
    // mistakenly mark a perfectly standalone unique index as "backing a
    // constraint" and we'd skip it. That's how `scans_request_id_key`
    // disappeared from the supplement candidate set: the FK
    // `scan_runtime_credentials.request_id → scans(request_id)` has its
    // `conindid` set to this very index.
    const res = await client.query(
      `SELECT
         n.nspname AS schema_name,
         t.relname AS table_name,
         i.relname AS index_name,
         pg_get_indexdef(i.oid) AS index_def
       FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
       JOIN pg_class t ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN pg_constraint c
         ON c.conindid = i.oid AND c.contype IN ('p', 'u')
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg_toast%'
         AND n.nspname NOT LIKE 'pg_temp_%'
         AND c.conindid IS NULL
       ORDER BY n.nspname, t.relname, i.relname`,
    );
    return res.rows.map((r) => ({
      schemaName: String(r.schema_name),
      tableName: String(r.table_name),
      indexName: String(r.index_name),
      indexDef: String(r.index_def),
    }));
  } finally {
    await client.end();
  }
}

// Authoritative enum-value listing from the live DB. drizzle-kit 0.31.x
// introspect occasionally drops enum values from its CREATE TYPE output
// (and from its snapshot.enums entry) while keeping CHECK constraints /
// column defaults that reference them — that produces 0000 SQL which fails
// at apply time with "invalid input value for enum".
export interface PgEnumInfo {
  schema: string;
  name: string;
  values: string[];
}

export async function listPgEnums(creds: DbCredentials): Promise<PgEnumInfo[]> {
  const pgMod = await safeImport<{
    default?: { Client: new (cfg: unknown) => unknown };
    Client?: new (cfg: unknown) => unknown;
  }>('pg', 'npm i pg');
  const Client = (pgMod.default?.Client ?? pgMod.Client) as new (cfg: unknown) => PgClientShape;
  const cfg: Record<string, unknown> = creds.url ? { connectionString: creds.url } : { ...creds };
  const client = new Client(cfg);
  await client.connect();
  try {
    const res = await client.query(
      // Cast enumlabel to text so node-postgres parses array_agg as text[]
      // (a JS array). Without the cast it comes back as the literal string
      // `{val1,val2,...}` because pg-types lacks a parser for the underlying
      // `name`/anyenum array OID.
      `SELECT
         n.nspname AS schema_name,
         t.typname AS enum_name,
         array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS enum_values
       FROM pg_type t
       JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       GROUP BY n.nspname, t.typname
       ORDER BY n.nspname, t.typname`,
    );
    return res.rows.map((r) => ({
      schema: String(r.schema_name),
      name: String(r.enum_name),
      values: (r.enum_values as string[]).map(String),
    }));
  } finally {
    await client.end();
  }
}

// Installed (non-builtin) extensions on the target. drizzle-kit introspect
// emits NO `CREATE EXTENSION` statements, so applying 0000 to a fresh DB
// silently lacks any extension that the schema actually depends on
// (pgcrypto's `gen_random_uuid()`, postgis types, hstore, etc.).
export interface PgExtensionInfo {
  name: string;
  schema: string;
}

export async function listPgExtensions(creds: DbCredentials): Promise<PgExtensionInfo[]> {
  const pgMod = await safeImport<{
    default?: { Client: new (cfg: unknown) => unknown };
    Client?: new (cfg: unknown) => unknown;
  }>('pg', 'npm i pg');
  const Client = (pgMod.default?.Client ?? pgMod.Client) as new (cfg: unknown) => PgClientShape;
  const cfg: Record<string, unknown> = creds.url ? { connectionString: creds.url } : { ...creds };
  const client = new Client(cfg);
  await client.connect();
  try {
    const res = await client.query(
      // plpgsql ships with postgres itself; skip it.
      `SELECT e.extname, n.nspname AS schema_name
       FROM pg_extension e
       JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname <> 'plpgsql'
       ORDER BY e.extname`,
    );
    return res.rows.map((r) => ({
      name: String(r.extname),
      schema: String(r.schema_name),
    }));
  } finally {
    await client.end();
  }
}

// Live column-default lookup. drizzle-kit introspect occasionally mangles
// defaults — most commonly `'{}'::text[]` (empty array) gets serialized as
// `'{""}'` (single-element empty-string array). pg_attrdef + pg_get_expr is
// the authoritative source.
export interface PgColumnDefault {
  schema: string;
  table: string;
  column: string;
  defaultExpr: string;
}

export async function listPgColumnDefaults(creds: DbCredentials): Promise<PgColumnDefault[]> {
  const pgMod = await safeImport<{
    default?: { Client: new (cfg: unknown) => unknown };
    Client?: new (cfg: unknown) => unknown;
  }>('pg', 'npm i pg');
  const Client = (pgMod.default?.Client ?? pgMod.Client) as new (cfg: unknown) => PgClientShape;
  const cfg: Record<string, unknown> = creds.url ? { connectionString: creds.url } : { ...creds };
  const client = new Client(cfg);
  await client.connect();
  try {
    const res = await client.query(
      `SELECT
         n.nspname AS schema_name,
         t.relname AS table_name,
         a.attname AS column_name,
         pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_attrdef d
       JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
       JOIN pg_class t ON t.oid = a.attrelid AND t.relkind IN ('r','p')
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND NOT a.attisdropped
       ORDER BY n.nspname, t.relname, a.attnum`,
    );
    return res.rows.map((r) => ({
      schema: String(r.schema_name),
      table: String(r.table_name),
      column: String(r.column_name),
      defaultExpr: String(r.default_expr),
    }));
  } finally {
    await client.end();
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
