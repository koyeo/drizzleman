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

// CHECK constraints whose predicate text references any of the given enum
// types. Used to repair migra's enum-rename block: when migra renames an
// enum (to `<name>__old_version_to_be_dropped`), any CHECK that compared
// values against `'foo'::enum_name` still binds to the OLD (now-renamed)
// enum oid; subsequent `ALTER COLUMN ... TYPE new_enum` then fails with
// "operator does not exist: <new> = <old>". Drop these CHECKs before the
// rename block, re-add them after the column alters.
export interface CheckReferencingEnum {
  schema: string;
  table: string;
  name: string;
  // pg_get_constraintdef output, e.g. `CHECK ((status = 'completed'::scan_status) ...)`
  definition: string;
}

export async function listChecksReferencingEnums(
  creds: DbCredentials,
  enumQualifiedNames: string[],
): Promise<CheckReferencingEnum[]> {
  if (enumQualifiedNames.length === 0) return [];
  const pgMod = await safeImport<{
    default?: { Client: new (cfg: unknown) => unknown };
    Client?: new (cfg: unknown) => unknown;
  }>('pg', 'npm i pg');
  const Client = (pgMod.default?.Client ?? pgMod.Client) as new (cfg: unknown) => PgClientShape;
  const cfg: Record<string, unknown> = creds.url ? { connectionString: creds.url } : { ...creds };
  const client = new Client(cfg);
  await client.connect();
  try {
    // CHECK constraint depends on a type via pg_depend (refclassid =
    // 'pg_type'::regclass). Filter to the enum types we care about.
    const res = await client.query(
      `WITH wanted AS (
         SELECT t.oid AS type_oid, n.nspname AS type_schema, t.typname AS type_name
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE format('%I.%I', n.nspname, t.typname) = ANY($1)
       )
       SELECT
         tn.nspname AS table_schema,
         tc.relname AS table_name,
         c.conname AS constraint_name,
         pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class tc ON tc.oid = c.conrelid
       JOIN pg_namespace tn ON tn.oid = tc.relnamespace
       JOIN pg_depend d ON d.objid = c.oid AND d.refclassid = 'pg_type'::regclass
       JOIN wanted w ON w.type_oid = d.refobjid
       WHERE c.contype = 'c'
       GROUP BY tn.nspname, tc.relname, c.conname, c.oid
       ORDER BY tn.nspname, tc.relname, c.conname`,
      [enumQualifiedNames],
    );
    return res.rows.map((r) => ({
      schema: String(r.table_schema),
      table: String(r.table_name),
      name: String(r.constraint_name),
      definition: String(r.def),
    }));
  } finally {
    await client.end();
  }
}

// Column DEFAULT expressions that bind to any of the given enum types. After
// `ALTER TYPE ... RENAME` migra issues for enum-shrink, these defaults still
// point at the OLD (now-renamed) enum oid, and the subsequent ALTER COLUMN
// TYPE fails. Drop them before the rename; migra re-issues SET DEFAULT
// against the new enum further down the diff.
export interface ColumnDefaultRef {
  schema: string;
  table: string;
  column: string;
}

export async function listDefaultsReferencingEnums(
  creds: DbCredentials,
  enumQualifiedNames: string[],
): Promise<ColumnDefaultRef[]> {
  if (enumQualifiedNames.length === 0) return [];
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
      `WITH wanted AS (
         SELECT t.oid AS type_oid
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE format('%I.%I', n.nspname, t.typname) = ANY($1)
       )
       SELECT
         n.nspname AS table_schema,
         c.relname AS table_name,
         a.attname AS column_name
       FROM pg_attrdef d
       JOIN pg_depend dep ON dep.objid = d.oid
         AND dep.classid = 'pg_attrdef'::regclass
         AND dep.refclassid = 'pg_type'::regclass
       JOIN wanted w ON w.type_oid = dep.refobjid
       JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       GROUP BY n.nspname, c.relname, a.attname
       ORDER BY n.nspname, c.relname, a.attname`,
      [enumQualifiedNames],
    );
    return res.rows.map((r) => ({
      schema: String(r.table_schema),
      table: String(r.table_name),
      column: String(r.column_name),
    }));
  } finally {
    await client.end();
  }
}

// Indexes whose definition (typically a partial-index WHERE clause)
// references any of the given enum types. After migra's enum rename, such
// indexes still bind to the OLD (renamed) enum oid; subsequent column
// ALTER fails with the same `operator does not exist` error as CHECK
// constraints. Drop them before the rename, re-add (via pg_get_indexdef)
// after the column alters.
export interface IndexReferencingEnum {
  schema: string;
  table: string;
  name: string;
  // pg_get_indexdef output — canonical CREATE INDEX statement (no trailing `;`).
  definition: string;
}

export async function listIndexesReferencingEnums(
  creds: DbCredentials,
  enumQualifiedNames: string[],
): Promise<IndexReferencingEnum[]> {
  if (enumQualifiedNames.length === 0) return [];
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
      `WITH wanted AS (
         SELECT t.oid AS type_oid
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE format('%I.%I', n.nspname, t.typname) = ANY($1)
       )
       SELECT
         n.nspname AS table_schema,
         tc.relname AS table_name,
         ic.relname AS index_name,
         pg_get_indexdef(ic.oid) AS def
       FROM pg_index ix
       JOIN pg_class ic ON ic.oid = ix.indexrelid
       JOIN pg_class tc ON tc.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = tc.relnamespace
       JOIN pg_depend d ON d.objid = ic.oid AND d.refclassid = 'pg_type'::regclass
       JOIN wanted w ON w.type_oid = d.refobjid
       GROUP BY n.nspname, tc.relname, ic.relname, ic.oid
       ORDER BY n.nspname, tc.relname, ic.relname`,
      [enumQualifiedNames],
    );
    return res.rows.map((r) => ({
      schema: String(r.table_schema),
      table: String(r.table_name),
      name: String(r.index_name),
      definition: String(r.def),
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
