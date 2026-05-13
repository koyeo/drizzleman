import { safeImport } from '../safeImport.js';

const VALID_DB_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

export function timestampForDbName(ms: number): string {
  // Local-timezone YYYYMMDDHHmmss (compact 14-digit), paired with the same
  // `ts = Date.now()` used for filesystem preview/bak/ref dirs and the
  // rebase diff-only record file so the four are recoverable as a set.
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export function deriveUrlWithDbName(adminUrl: string, dbName: string): string {
  if (!VALID_DB_NAME.test(dbName)) {
    throw new Error(`invalid db name (must match /^[A-Za-z_][A-Za-z0-9_]*$/): ${dbName}`);
  }
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

// Probe admin URL by issuing a no-op query AND inspecting role privileges. We
// don't actually try CREATE DATABASE here (because creating then dropping a DB
// just to probe would itself need privileges we may lack); instead, we read
// `rolcreatedb` / `rolsuper` from pg_roles for the connected user.
export async function checkCreateDbPrivilege(adminUrl: string): Promise<void> {
  let client: PgClient;
  try {
    client = await connect(adminUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`admin DB connection failed: ${msg}`);
  }
  try {
    const res = await client.query(
      `SELECT rolcreatedb, rolsuper FROM pg_roles WHERE rolname = current_user`,
    );
    const row = res.rows[0];
    const canCreate = row && (row.rolcreatedb === true || row.rolsuper === true);
    if (!canCreate) {
      throw new Error(
        `admin DB user lacks CREATEDB privilege. ` +
          `Connect as a superuser, or grant: ALTER ROLE "<user>" CREATEDB;`,
      );
    }
  } finally {
    await client.end();
  }
}

export async function createDatabaseViaAdmin(
  adminUrl: string,
  dbName: string,
): Promise<void> {
  if (!VALID_DB_NAME.test(dbName)) {
    throw new Error(`invalid db name (must match /^[A-Za-z_][A-Za-z0-9_]*$/): ${dbName}`);
  }
  const client = await connect(adminUrl);
  try {
    // CREATE DATABASE cannot run inside an explicit transaction block. The pg
    // driver leaves `client.query(...)` in autocommit mode by default, so a
    // single statement is fine. Do NOT wrap this in BEGIN/COMMIT.
    await client.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
  } finally {
    await client.end();
  }
}
