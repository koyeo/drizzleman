import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import pc from 'picocolors';
import { migrationsTableOf } from '../config.js';
import {
  assertSchemaDbEmpty,
  readApplied,
  resetAppliedToRebase,
} from '../db/index.js';
import {
  createDatabaseViaAdmin,
  checkCreateDbPrivilege,
  deriveUrlWithDbName,
  timestampForDbName,
} from '../db/provision.js';
import {
  listChecksReferencingEnums,
  listDefaultsReferencingEnums,
  listIndexesReferencingEnums,
  probeDb,
  type DbProbe,
} from '../db/probe.js';
import { runSqlFile, type RunSqlResult } from '../db/runSql.js';
import { passthrough } from '../passthrough.js';
import type { AppliedRow, DbCredentials, DrizzleConfig } from '../types.js';
import { targetUrl as renderUrl } from '../url.js';
import { preTarget } from './preTarget.js';

// ---- constants ----

const PREVIEW_PREFIX = '.rebase-preview-';
const BAK_PREFIX = '.rebase-bak-';
const REF_PREFIX = '.rebase-ref-';
const TMPGEN_PREFIX = 'drizzleman-rebase-tmpgen-'; // under /tmp
const ENV_SCHEMA_DB_URL = 'DRIZZLEMAN_EMPTY_SCHEMA_DB_URL';
const ENV_VERIFY_DB_URL = 'DRIZZLEMAN_EMPTY_VERIFY_DB_URL';
const ENV_ADMIN_DB_URL = 'DRIZZLEMAN_ADMIN_DB_URL';

// Reference files (carried alongside the preview as schema source, not as
// migrations). Promoted into `.rebase-ref-<ts>/` rather than the migrations
// dir proper. We keep schema.ts / relations.ts only when drizzle-kit emits
// them (it does for introspect; generate doesn't — so this set may be unused
// in the new flow, but kept for forward-compat).
const REF_FILE_NAMES = new Set(['schema.ts', 'relations.ts']);

// ---- flags ----

interface RebaseFlags {
  yes: boolean;
  name: string;
  schemaDbUrl: string | null;
  verifyDbUrl: string | null;
  adminDbUrl: string | null;
  verifyOnly: boolean;
  checkOnly: boolean;
  allowVersionMismatch: boolean;
  rest: string[];
}

function consumeFlags(args: string[]): RebaseFlags {
  // Drop the leading 'rebase' command word so we don't accidentally forward it
  // to drizzle-kit's generate/migrate (brocli rejects unknown positionals).
  const start = args[0] === 'rebase' ? 1 : 0;
  let yes = false;
  let name = 'baseline';
  let schemaDbUrl: string | null = null;
  let verifyDbUrl: string | null = null;
  let adminDbUrl: string | null = null;
  let verifyOnly = false;
  let checkOnly = false;
  let allowVersionMismatch = false;
  const rest: string[] = [];
  for (let i = start; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--yes' || a === '-y') { yes = true; continue; }
    if (a === '--verify-only') { verifyOnly = true; continue; }
    if (a === '--check-only') { checkOnly = true; continue; }
    if (a === '--allow-version-mismatch') { allowVersionMismatch = true; continue; }
    if (a === '--name') { name = args[++i] ?? name; continue; }
    if (a.startsWith('--name=')) { name = a.slice('--name='.length); continue; }
    if (a === '--empty-schema-db-url') { schemaDbUrl = args[++i] ?? null; continue; }
    if (a.startsWith('--empty-schema-db-url=')) {
      schemaDbUrl = a.slice('--empty-schema-db-url='.length);
      continue;
    }
    if (a === '--verify-db-url') { verifyDbUrl = args[++i] ?? null; continue; }
    if (a.startsWith('--verify-db-url=')) {
      verifyDbUrl = a.slice('--verify-db-url='.length);
      continue;
    }
    if (a === '--admin-db-url') { adminDbUrl = args[++i] ?? null; continue; }
    if (a.startsWith('--admin-db-url=')) {
      adminDbUrl = a.slice('--admin-db-url='.length);
      continue;
    }
    rest.push(a);
  }
  return {
    yes,
    name,
    schemaDbUrl,
    verifyDbUrl,
    adminDbUrl,
    verifyOnly,
    checkOnly,
    allowVersionMismatch,
    rest,
  };
}

// ---- helpers ----

async function promptApply(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      pc.bold('Promote preview into migrations dir and reset DB migration table? [y/N] '),
      (ans) => {
        rl.close();
        const t = ans.trim().toLowerCase();
        resolve(t === 'y' || t === 'yes');
      },
    );
  });
}

function rel(p: string): string {
  return path.relative(process.cwd(), p) || '.';
}

function hashFile(p: string): string {
  return createHash('sha256').update(readFileSync(p, 'utf8')).digest('hex');
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function countLines(p: string): number {
  const s = readFileSync(p, 'utf8');
  if (s === '') return 0;
  return s.split('\n').length;
}

function buildSchemaArgs(schema: DrizzleConfig['schema']): string[] {
  if (!schema) return [];
  if (Array.isArray(schema)) return schema.map((s) => `--schema=${s}`);
  return [`--schema=${schema}`];
}

function maskUrl(url: string): string {
  return renderUrl({ dialect: 'postgresql', out: '', dbCredentials: { url } });
}

// migra is built on SQLAlchemy, whose URL dialect registry only recognises
// `postgresql://` — `postgres://` raises "NoSuchModuleError: Can't load
// plugin: sqlalchemy.dialects:postgres". pg.Client accepts both, so we
// keep one normalizer used everywhere we hand a URL to migra (and we use it
// for pg.Client too just to keep the surface uniform).
function normalizeUrlToPostgresql(url: string): string {
  if (/^postgres:\/\//i.test(url)) return url.replace(/^postgres:\/\//i, 'postgresql://');
  return url;
}

function cleanupDir(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// drizzle-kit 0.31.x generate (and introspect) emits CREATE TABLE → ALTER ADD
// FK → CREATE INDEX, in that order. If a FK references a column whose
// uniqueness is provided by a uniqueIndex (declared in pgTable's second-arg
// callback rather than as a column-level `.unique()`), postgres rejects the
// FK at apply time:
//   ERROR: there is no unique constraint matching given keys for referenced
//   table "..."  [SQLSTATE 42830]
// Bucket the statements so CREATE TYPE → CREATE TABLE → CREATE [UNIQUE]
// INDEX → ALTER … ADD FK, preserving relative order within each bucket.
// This is the only post-processing we still do on generate's output — the
// rest of the bug-supplement code (opclass / enum value / column default
// / standalone unique index) is no longer needed because generate is
// authoritative for local schema (introspect was the unreliable source).
function reorderForFkSafety(sql: string): string {
  const SEP = '--> statement-breakpoint';
  const parts = sql.split(SEP);
  type Bucket = 'pre' | 'extension' | 'type' | 'table' | 'index' | 'fk' | 'other';
  const buckets: Record<Bucket, string[]> = {
    pre: [],
    extension: [],
    type: [],
    table: [],
    index: [],
    fk: [],
    other: [],
  };
  for (const raw of parts) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      buckets.pre.push(raw);
      continue;
    }
    if (/^\s*CREATE\s+EXTENSION\s/i.test(trimmed)) buckets.extension.push(raw);
    else if (/^\s*CREATE\s+TYPE\s/i.test(trimmed)) buckets.type.push(raw);
    else if (/^\s*CREATE\s+(?:UNLOGGED\s+|TEMP\s+|TEMPORARY\s+)?TABLE\s/i.test(trimmed))
      buckets.table.push(raw);
    else if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s/i.test(trimmed)) buckets.index.push(raw);
    else if (
      /^\s*ALTER\s+TABLE\s+.+?\s+ADD\s+CONSTRAINT\s+"[^"]+"\s+FOREIGN\s+KEY/is.test(trimmed)
    )
      buckets.fk.push(raw);
    else buckets.other.push(raw);
  }
  return [
    ...buckets.pre,
    ...buckets.extension,
    ...buckets.type,
    ...buckets.table,
    ...buckets.index,
    ...buckets.fk,
    ...buckets.other,
  ].join(SEP);
}

// ---- temp-DB URL resolution (manual vs admin auto-provision) ----

interface ResolvedTempDbs {
  schemaDbUrl: string;
  verifyDbUrl: string;
  // When admin-mode auto-provisioned the two DBs, the bare names go here so
  // the final reminder can print exact `DROP DATABASE "..."` commands.
  provisioned: { schema: string | null; verify: string | null };
}

async function resolveTempDbUrls(
  flags: RebaseFlags,
  ts: number,
): Promise<ResolvedTempDbs> {
  const envSchema = process.env[ENV_SCHEMA_DB_URL] ?? null;
  const envVerify = process.env[ENV_VERIFY_DB_URL] ?? null;
  const envAdmin = process.env[ENV_ADMIN_DB_URL] ?? null;
  const schemaFromUser = flags.schemaDbUrl ?? envSchema;
  const verifyFromUser = flags.verifyDbUrl ?? envVerify;
  const adminFromUser = flags.adminDbUrl ?? envAdmin;

  const hasManual = schemaFromUser !== null || verifyFromUser !== null;
  if (adminFromUser !== null && hasManual) {
    throw new Error(
      `--admin-db-url is mutually exclusive with --empty-schema-db-url / --verify-db-url. ` +
        `Pick one mode: (a) admin URL → drizzleman auto-creates two DBs, or ` +
        `(b) manual URLs → you provide two pre-created empty DBs.`,
    );
  }

  if (adminFromUser !== null) {
    await checkCreateDbPrivilege(adminFromUser);
    const tsName = timestampForDbName(ts);
    const schemaName = `drizzleman_${tsName}_schema_db`;
    const verifyName = `drizzleman_${tsName}_verify_db`;
    console.log(pc.bold('[drizzleman] Admin-mode: creating two temp databases'));
    console.log(pc.dim(`  via ${pc.cyan(maskUrl(adminFromUser))}`));
    try {
      await createDatabaseViaAdmin(adminFromUser, schemaName);
      console.log(pc.green(`  ✓ created ${schemaName}`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `failed to CREATE DATABASE "${schemaName}": ${msg}. ` +
          `Nothing was provisioned. Retry or use manual --empty-schema-db-url + --verify-db-url.`,
      );
    }
    try {
      await createDatabaseViaAdmin(adminFromUser, verifyName);
      console.log(pc.green(`  ✓ created ${verifyName}`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `failed to CREATE DATABASE "${verifyName}": ${msg}. ` +
          `"${schemaName}" was created and is NOT auto-dropped — clean up with: DROP DATABASE "${schemaName}";`,
      );
    }
    const schemaDbUrl = deriveUrlWithDbName(adminFromUser, schemaName);
    const verifyDbUrl = deriveUrlWithDbName(adminFromUser, verifyName);
    return {
      schemaDbUrl,
      verifyDbUrl,
      provisioned: { schema: schemaName, verify: verifyName },
    };
  }

  if (schemaFromUser === null || verifyFromUser === null) {
    throw new Error(
      `rebase requires either (a) --admin-db-url (auto-provision) or (b) both ` +
        `--empty-schema-db-url + --verify-db-url (manual). Missing: ` +
        `${schemaFromUser === null ? '--empty-schema-db-url ' : ''}` +
        `${verifyFromUser === null ? '--verify-db-url' : ''}`.trim() +
        `. Env vars: ${ENV_ADMIN_DB_URL} / ${ENV_SCHEMA_DB_URL} / ${ENV_VERIFY_DB_URL}.`,
    );
  }
  if (schemaFromUser === verifyFromUser) {
    throw new Error('--empty-schema-db-url and --verify-db-url must point to different databases.');
  }

  return {
    schemaDbUrl: schemaFromUser,
    verifyDbUrl: verifyFromUser,
    provisioned: { schema: null, verify: null },
  };
}

// ---- migra wrapper ----

interface MigraResult {
  ok: boolean;       // true = stdout was empty (no diff)
  sql: string;       // captured stdout
  error: string | null;
}

// Spawn migra, capture stdout into a string. For "verify final check"
// (small expected diff, displayed inline) and other in-memory uses.
function runMigra(
  fromUrl: string,
  toUrl: string,
  excludeSchemas: string[],
): Promise<MigraResult> {
  return new Promise((resolve) => {
    const args = ['--unsafe'];
    // migra's argparse uses underscore: --exclude_schema (not --exclude-schema).
    for (const s of excludeSchemas) args.push(`--exclude_schema=${s}`);
    args.push(normalizeUrlToPostgresql(fromUrl), normalizeUrlToPostgresql(toUrl));

    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn('migra', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resolve({
        ok: false,
        sql: '',
        error: `failed to spawn migra: ${msg}. Install with: pipx install migra (or pip install migra psycopg2-binary).`,
      });
      return;
    }
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString();
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        resolve({
          ok: false,
          sql: '',
          error:
            'migra not found on PATH. Install with: pipx install migra ' +
            '(or pip install migra psycopg2-binary). See https://github.com/djrobstep/migra.',
        });
      } else {
        resolve({ ok: false, sql: '', error: `migra failed: ${err.message}` });
      }
    });
    child.on('exit', (code) => {
      const trimmed = stdout.trim();
      // migra exit codes with --unsafe: 0 = equal, 2 = differ (diff printed),
      // 3 = unsafe refused (shouldn't happen with --unsafe), 1 = error.
      // Trust stdout as source of truth.
      if (code === 0 || code === 2 || code === 3) {
        resolve({ ok: trimmed.length === 0, sql: stdout, error: null });
      } else {
        resolve({
          ok: false,
          sql: stdout,
          error:
            `migra exited ${code}${stderr.trim().length > 0 ? `: ${stderr.trim()}` : ''}`,
        });
      }
    });
  });
}

// Same migra invocation but stream stdout straight to a file. Used by Step C
// (target dump can be megabytes — don't buffer in JS) and Step D (diff.sql).
// Returns the byte count written so the caller can report it.
function runMigraToFile(
  fromUrl: string,
  toUrl: string,
  excludeSchemas: string[],
  outFile: string,
): Promise<{ ok: boolean; byteCount: number; error: string | null }> {
  return new Promise((resolve) => {
    const args = ['--unsafe'];
    for (const s of excludeSchemas) args.push(`--exclude_schema=${s}`);
    args.push(normalizeUrlToPostgresql(fromUrl), normalizeUrlToPostgresql(toUrl));

    let stderr = '';
    let byteCount = 0;
    let child;
    try {
      child = spawn('migra', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resolve({
        ok: false,
        byteCount: 0,
        error: `failed to spawn migra: ${msg}. Install with: pipx install migra.`,
      });
      return;
    }
    const out = createWriteStream(outFile);
    child.stdout.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      byteCount += buf.length;
      out.write(buf);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString();
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      out.end();
      if (err.code === 'ENOENT') {
        resolve({
          ok: false,
          byteCount: 0,
          error:
            'migra not found on PATH. Install with: pipx install migra ' +
            '(or pip install migra psycopg2-binary).',
        });
      } else {
        resolve({ ok: false, byteCount: 0, error: `migra failed: ${err.message}` });
      }
    });
    child.on('exit', (code) => {
      out.end(() => {
        if (code === 0 || code === 2 || code === 3) {
          resolve({ ok: true, byteCount, error: null });
        } else {
          resolve({
            ok: false,
            byteCount,
            error:
              `migra exited ${code}${stderr.trim().length > 0 ? `: ${stderr.trim()}` : ''}`,
          });
        }
      });
    });
  });
}

// ---- diff.sql post-process: repair enum-rename CHECK constraint dependency ----
//
// migra's enum-shrink dance — `ALTER TYPE x RENAME TO x__old_version_to_be_dropped`
// → `CREATE TYPE x AS ENUM (...)` → `ALTER COLUMN ... TYPE new_x USING ...` — leaves
// any CHECK constraint that compared against `'lit'::x` bound to the now-renamed
// OLD enum oid. Then the column ALTER fails:
//   ERROR: operator does not exist: scan_status = scan_status__old_version_to_be_dropped
// Fix: for every enum migra renames, find target's CHECKs that reference it,
// inject DROP CONSTRAINT before the rename block (top of file) and ADD CONSTRAINT
// after the column alters (bottom of file). The reads from target are pure
// pg_catalog selects — G1/G5 compliant.
async function repairEnumRenameCheckDeps(
  diffFile: string,
  targetCreds: DbCredentials,
): Promise<{
  touchedEnums: number;
  injectedCheckDrops: number;
  injectedCheckAdds: number;
  injectedDefaultDrops: number;
  injectedIndexDrops: number;
  injectedIndexAdds: number;
}> {
  const body = readFileSync(diffFile, 'utf8');
  // Match `alter type "schema"."name" rename to "name__old_version_to_be_dropped"`
  // (also tolerate unquoted identifiers, which migra occasionally emits).
  const renameRe =
    /alter\s+type\s+(?:"([^"]+)"|([A-Za-z_][\w]*))\.(?:"([^"]+)"|([A-Za-z_][\w]*))\s+rename\s+to\s+(?:"[^"]+"|[A-Za-z_][\w]*__old_version_to_be_dropped)/gi;
  const enumKeys = new Set<string>();
  for (const m of body.matchAll(renameRe)) {
    const schema = m[1] ?? m[2] ?? 'public';
    const name = m[3] ?? m[4] ?? '';
    if (name) enumKeys.add(`${schema}.${name}`);
  }
  if (enumKeys.size === 0) {
    return {
      touchedEnums: 0,
      injectedCheckDrops: 0,
      injectedCheckAdds: 0,
      injectedDefaultDrops: 0,
      injectedIndexDrops: 0,
      injectedIndexAdds: 0,
    };
  }
  const enumKeysArr = Array.from(enumKeys);
  const [checks, defaults, indexes] = await Promise.all([
    listChecksReferencingEnums(targetCreds, enumKeysArr),
    listDefaultsReferencingEnums(targetCreds, enumKeysArr),
    listIndexesReferencingEnums(targetCreds, enumKeysArr),
  ]);

  // Migra may already emit `drop constraint "X"` / `drop index ...` for some
  // of these (the ones whose predicate references enum values being shrunk
  // and which therefore can't be re-added against the new enum). Skip those:
  // migra owns them. We only handle the ones migra leaves alone — those
  // need a temporary drop + re-add around the enum rename block.
  const migraDropConstraints = new Set<string>();
  const dropConstraintRe =
    /alter\s+table\s+(?:"([^"]+)"|([A-Za-z_][\w]*))\.(?:"([^"]+)"|([A-Za-z_][\w]*))\s+drop\s+constraint\s+(?:"([^"]+)"|([A-Za-z_][\w]*))/gi;
  for (const m of body.matchAll(dropConstraintRe)) {
    const schema = m[1] ?? m[2] ?? 'public';
    const table = m[3] ?? m[4] ?? '';
    const name = m[5] ?? m[6] ?? '';
    if (table && name) migraDropConstraints.add(`${schema}.${table}.${name}`);
  }
  const migraDropIndexes = new Set<string>();
  const dropIndexRe =
    /drop\s+index\s+(?:if\s+exists\s+)?(?:"([^"]+)"|([A-Za-z_][\w]*))\.(?:"([^"]+)"|([A-Za-z_][\w]*))/gi;
  for (const m of body.matchAll(dropIndexRe)) {
    const schema = m[1] ?? m[2] ?? 'public';
    const name = m[3] ?? m[4] ?? '';
    if (name) migraDropIndexes.add(`${schema}.${name}`);
  }

  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  const checkDrops: string[] = [];
  const checkAdds: string[] = [];
  for (const c of checks) {
    const key = `${c.schema}.${c.table}.${c.name}`;
    if (migraDropConstraints.has(key)) continue; // migra already drops this
    checkDrops.push(`alter table ${q(c.schema)}.${q(c.table)} drop constraint ${q(c.name)};`);
    checkAdds.push(`alter table ${q(c.schema)}.${q(c.table)} add constraint ${q(c.name)} ${c.definition};`);
  }

  // Column defaults: drop them BEFORE the enum rename block. We do NOT re-add
  // them — migra emits its own `ALTER COLUMN ... SET DEFAULT 'foo'::new_enum`
  // further down, which is what we want (the new default binds to the new
  // enum oid).
  const defaultDrops: string[] = [];
  for (const d of defaults) {
    defaultDrops.push(
      `alter table ${q(d.schema)}.${q(d.table)} alter column ${q(d.column)} drop default;`,
    );
  }

  // Indexes (typically partial-index WHERE clauses): drop + re-add via
  // pg_get_indexdef. Same migra-dedupe logic as for checks.
  const indexDrops: string[] = [];
  const indexAdds: string[] = [];
  for (const i of indexes) {
    const key = `${i.schema}.${i.name}`;
    if (migraDropIndexes.has(key)) continue; // migra already drops this
    indexDrops.push(`drop index ${q(i.schema)}.${q(i.name)};`);
    indexAdds.push(`${i.definition.trim().replace(/;\s*$/, '')};`);
  }

  if (
    checkDrops.length === 0 &&
    defaultDrops.length === 0 &&
    indexDrops.length === 0
  ) {
    return {
      touchedEnums: enumKeys.size,
      injectedCheckDrops: 0,
      injectedCheckAdds: 0,
      injectedDefaultDrops: 0,
      injectedIndexDrops: 0,
      injectedIndexAdds: 0,
    };
  }

  const headerParts: string[] = [];
  if (defaultDrops.length > 0) {
    headerParts.push(
      `-- drizzleman: drop ${defaultDrops.length} column default(s) that bind to enums being shrunk ` +
        `(migra re-applies new defaults via SET DEFAULT later).\n` +
        defaultDrops.join('\n'),
    );
  }
  if (checkDrops.length > 0) {
    headerParts.push(
      `-- drizzleman: drop ${checkDrops.length} CHECK constraint(s) that bind to enums being shrunk ` +
        `(workaround for migra not handling enum-rename dependent checks; we re-add them at the bottom).\n` +
        checkDrops.join('\n'),
    );
  }
  if (indexDrops.length > 0) {
    headerParts.push(
      `-- drizzleman: drop ${indexDrops.length} index(es) whose WHERE clause binds to enums being shrunk ` +
        `(workaround for migra not handling enum-rename dependent indexes; we re-add them at the bottom).\n` +
        indexDrops.join('\n'),
    );
  }
  const header = headerParts.join('\n\n') + '\n\n';
  const footerParts: string[] = [];
  if (checkAdds.length > 0) {
    footerParts.push(
      `-- drizzleman: re-add the ${checkAdds.length} CHECK constraint(s) dropped at the top of this file ` +
        `(now binding to the new enum oid).\n` +
        checkAdds.join('\n'),
    );
  }
  if (indexAdds.length > 0) {
    footerParts.push(
      `-- drizzleman: re-add the ${indexAdds.length} index(es) dropped at the top of this file ` +
        `(now binding to the new enum oid).\n` +
        indexAdds.join('\n'),
    );
  }
  // Move every `drop type "..."__old_version_to_be_dropped"` statement to the
  // very end of the file. Migra emits these AFTER ALTER COLUMN TYPE but
  // BEFORE DROP COLUMN — which fails when a column to be dropped still has
  // the old type, since postgres refuses to drop a type that still has
  // dependents (the not-yet-dropped column itself, plus our re-added
  // CHECKs/INDEXes at the bottom of the file).
  const dropTypeRe = /^drop\s+type\s+"[^"]+"\."[^"]+__old_version_to_be_dropped";?\s*$/gim;
  const movedDropTypes: string[] = [];
  const bodyWithoutDropTypes = body.replace(dropTypeRe, (m) => {
    movedDropTypes.push(m.trim().endsWith(';') ? m.trim() : `${m.trim()};`);
    return ''; // remove in place
  });
  const trailingDropTypeBlock =
    movedDropTypes.length > 0
      ? `\n\n-- drizzleman: deferred ${movedDropTypes.length} \`drop type ..._old_version_to_be_dropped\` ` +
        `to file end so they run AFTER drop-column / re-add-check / re-add-index.\n` +
        movedDropTypes.join('\n') +
        '\n'
      : '';

  const footer = footerParts.length > 0 ? '\n\n' + footerParts.join('\n\n') + '\n' : '';
  writeFileSync(diffFile, header + bodyWithoutDropTypes + footer + trailingDropTypeBlock);
  return {
    touchedEnums: enumKeys.size,
    injectedCheckDrops: checkDrops.length,
    injectedCheckAdds: checkAdds.length,
    injectedDefaultDrops: defaultDrops.length,
    injectedIndexDrops: indexDrops.length,
    injectedIndexAdds: indexAdds.length,
  };
}

// ---- destructive-DDL detector (preview UX) ----

interface DestructiveStats {
  totalLines: number;
  dropTable: number;
  dropColumn: number;
  dropConstraint: number;
  dropIndex: number;
  dropType: number;
  dropOther: number;
  alterDrop: number;
}

function scanDestructive(sqlFile: string): DestructiveStats {
  const content = readFileSync(sqlFile, 'utf8');
  const stats: DestructiveStats = {
    totalLines: content.split('\n').length,
    dropTable: 0,
    dropColumn: 0,
    dropConstraint: 0,
    dropIndex: 0,
    dropType: 0,
    dropOther: 0,
    alterDrop: 0,
  };
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (/^drop\s+table\b/i.test(t)) stats.dropTable++;
    else if (/^drop\s+index\b/i.test(t)) stats.dropIndex++;
    else if (/^drop\s+type\b/i.test(t)) stats.dropType++;
    else if (/^drop\b/i.test(t)) stats.dropOther++;
    else if (/^alter\s+table\b.*\bdrop\s+column\b/i.test(t)) stats.dropColumn++;
    else if (/^alter\s+table\b.*\bdrop\s+constraint\b/i.test(t)) stats.dropConstraint++;
    else if (/^alter\s+table\b.*\bdrop\b/i.test(t)) stats.alterDrop++;
  }
  return stats;
}

function hasAnyDestructive(s: DestructiveStats): boolean {
  return (
    s.dropTable + s.dropColumn + s.dropConstraint + s.dropIndex + s.dropType + s.dropOther + s.alterDrop > 0
  );
}

// ---- main ----

export async function runRebase(args: string[]): Promise<number> {
  const flags = consumeFlags(args);
  const { yes, name, verifyOnly, rest } = flags;

  const config = await preTarget(rest);

  if (config.dialect !== 'postgresql') {
    console.log(
      pc.red(
        `[drizzleman] ✗ rebase currently supports only dialect=postgresql; got "${config.dialect}". ` +
          `Use the regular drizzle-kit / drizzleman migrate workflow for other dialects.`,
      ),
    );
    return 1;
  }

  if (!config.schema) {
    console.log(
      pc.red(
        `[drizzleman] ✗ drizzle config has no 'schema' field; cannot generate 0000 from local schema. ` +
          `Add e.g. schema: './src/schema/index.ts' and retry.`,
      ),
    );
    return 1;
  }

  const ts = Date.now();

  // Resolve schema/verify DB URLs (manual or admin-mode auto-provision).
  let resolvedDbs: ResolvedTempDbs;
  try {
    resolvedDbs = await resolveTempDbUrls(flags, ts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`[drizzleman] ✗ ${msg}`));
    return 1;
  }
  const { schemaDbUrl, verifyDbUrl, provisioned } = resolvedDbs;

  const outDir = path.resolve(process.cwd(), config.out);
  const table = migrationsTableOf(config);
  const tableLabel = `${table.schema ? `${table.schema}.` : ''}${table.table}`;
  // migra exclusion: drizzle's own bookkeeping schema (`drizzle` by default
  // for postgres). Used across all migra invocations so that the
  // `__drizzle_migrations` table doesn't show up as a spurious diff between
  // verify, target, and schema DBs.
  const migrationsSchema = table.schema ?? 'drizzle';
  const migraExcludes = [migrationsSchema];

  const tsLabel = timestampForDbName(ts);
  const previewName = `${PREVIEW_PREFIX}${tsLabel}`;
  const previewDir = path.join(outDir, previewName);
  const bakSlug = `rebase-bak-${tsLabel}`;
  const bakDir = path.join(outDir, `.${bakSlug}`);
  const refSlug = `rebase-ref-${tsLabel}`;
  const refDir = path.join(outDir, `.${refSlug}`);
  const bakTableLabel = `${table.schema ? `${table.schema}.` : ''}${bakSlug}`;

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  if (existsSync(previewDir)) {
    console.log(pc.red(`[drizzleman] ✗ preview dir already exists: ${rel(previewDir)}; remove it and retry.`));
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }

  console.log(pc.dim(`[drizzleman] Schema DB: ${pc.cyan(maskUrl(schemaDbUrl))}`));
  console.log(pc.dim(`[drizzleman] Verify DB: ${pc.cyan(maskUrl(verifyDbUrl))}`));

  let applied: AppliedRow[] = [];
  let appliedError: string | null = null;
  try {
    applied = await readApplied(config.dialect, config.dbCredentials, table);
  } catch (err) {
    appliedError = err instanceof Error ? err.message : String(err);
  }

  const existingMigrationFiles = readdirSync(outDir).filter(
    (n) => !n.startsWith(PREVIEW_PREFIX) && !n.startsWith(BAK_PREFIX) && !n.startsWith(REF_PREFIX),
  );

  console.log(pc.bold('[drizzleman] Current state:'));
  console.log(`  existing entries in ${rel(outDir)}/ : ${pc.cyan(String(existingMigrationFiles.length))}`);
  if (appliedError) {
    console.log(`  DB rows in ${tableLabel}            : ${pc.yellow('(read failed)')} ${pc.dim(appliedError)}`);
  } else {
    console.log(`  DB rows in ${tableLabel}            : ${pc.cyan(String(applied.length))}`);
  }

  // ---- Step P0: assert both temp DBs empty ----
  console.log(pc.bold('\n[drizzleman] Step P0: assert schema/verify DBs are empty'));
  try {
    await assertSchemaDbEmpty(config.dialect, { url: schemaDbUrl });
    console.log(pc.green('  ✓ schema DB has no user-schema tables'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`  ✗ schema DB: ${msg}`));
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  try {
    await assertSchemaDbEmpty(config.dialect, { url: verifyDbUrl });
    console.log(pc.green('  ✓ verify DB has no user-schema tables'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`  ✗ verify DB: ${msg}`));
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }

  // ---- Step P1: probe engines & versions of all three DBs ----
  console.log(pc.bold('\n[drizzleman] Step P1: probe DB engines & versions'));
  const probeResults = await Promise.allSettled([
    probeDb(config.dialect, config.dbCredentials),
    probeDb(config.dialect, { url: schemaDbUrl }),
    probeDb(config.dialect, { url: verifyDbUrl }),
  ]);
  const probeLabels = ['target', 'schema', 'verify'] as const;
  const probeOk: DbProbe[] = [];
  let probeFailed = false;
  for (let i = 0; i < probeResults.length; i++) {
    const r = probeResults[i]!;
    const label = probeLabels[i]!;
    if (r.status === 'fulfilled') {
      probeOk.push(r.value);
      console.log(
        `  ${label.padEnd(7)}: ${pc.cyan(r.value.engine.padEnd(12))} ` +
          `${pc.cyan(r.value.releaseLabel.padEnd(10))} ` +
          `${pc.dim(r.value.versionString)}`,
      );
    } else {
      probeFailed = true;
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.log(pc.red(`  ${label.padEnd(7)}: ✗ probe failed: ${msg}`));
    }
  }
  if (probeFailed) {
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  const engines = new Set(probeOk.map((p) => p.engine));
  if (engines.size > 1) {
    const matrix = probeOk.map((p, i) => `${probeLabels[i]}=${p.engine}`).join(' / ');
    console.log(
      pc.red(
        `  ✗ engine mismatch: ${matrix}. All three DBs must report the same engine in version().`,
      ),
    );
    console.log(
      pc.dim(
        `    --allow-version-mismatch only relaxes major-version checks; engine mismatch is never overridable.`,
      ),
    );
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  const majors = new Set(probeOk.map((p) => p.majorVersion));
  if (majors.size > 1) {
    const matrix = probeOk.map((p, i) => `${probeLabels[i]}=${p.majorVersion}`).join(' / ');
    if (flags.allowVersionMismatch) {
      console.log(
        pc.yellow(
          `  ⚠ major version mismatch: ${matrix}. --allow-version-mismatch given → continuing, but verify may not represent target behaviour.`,
        ),
      );
    } else {
      console.log(
        pc.red(`  ✗ major version mismatch: ${matrix}. Pass --allow-version-mismatch to override.`),
      );
      printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
      return 1;
    }
  } else {
    console.log(pc.green('  ✓ engines and major versions agree'));
  }

  // ---- --check-only exit: stop before writing any preview / SQL ----
  if (flags.checkOnly) {
    console.log(pc.green('\n[drizzleman] ✓ --check-only: preflight checks all passed.'));
    console.log(pc.dim('  No preview generated, no SQL written, no DB mutated.'));
    if (provisioned.schema || provisioned.verify) {
      console.log(
        pc.dim('  Admin-mode auto-created two temp DBs; they remain (not auto-dropped). See reminder below.'),
      );
    }
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 0;
  }

  // From here on the preview dir is the workspace.
  mkdirSync(previewDir, { recursive: true });

  // ---- Step A: drizzle-kit generate from LOCAL schema → 0000.sql ----
  //
  // The single biggest design shift vs the old rebase: 0000 represents the
  // *local schema*, not the target. drizzle-kit generate is authoritative
  // here (it's the daily drizzle workflow), so we trust its SQL output
  // verbatim — no post-processing supplements needed.
  console.log(pc.bold(`\n[drizzleman] Step A: drizzle-kit generate (local schema) → 0000_${name}.sql`));
  const tmpgenDir = path.join('/tmp', `${TMPGEN_PREFIX}${tsLabel}`);
  if (existsSync(tmpgenDir)) {
    console.log(pc.red(`[drizzleman] ✗ tmpgen dir already exists: ${tmpgenDir}; remove it and retry.`));
    cleanupDir(previewDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  mkdirSync(tmpgenDir, { recursive: true });
  console.log(pc.dim(`  tmpgen: ${tmpgenDir}`));

  const genCode = await passthrough([
    'generate',
    `--dialect=${config.dialect}`,
    ...buildSchemaArgs(config.schema),
    `--out=${tmpgenDir}`,
    `--name=${name}`,
  ]);
  if (genCode !== 0) {
    console.log(pc.red(`[drizzleman] ✗ drizzle-kit generate exited ${genCode}.`));
    cleanupDir(previewDir);
    cleanupDir(tmpgenDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return genCode;
  }

  // Find the just-generated 0000 SQL file in tmpgen and move it (and its
  // companion snapshot + journal) into previewDir under canonical names.
  const tmpgenJournalPath = path.join(tmpgenDir, 'meta', '_journal.json');
  if (!existsSync(tmpgenJournalPath)) {
    console.log(pc.red(`[drizzleman] ✗ tmpgen journal missing at ${tmpgenJournalPath}.`));
    cleanupDir(previewDir);
    cleanupDir(tmpgenDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  // Migrate tmpgen → previewDir wholesale (sql + meta + drizzle.config holder).
  mkdirSync(path.join(previewDir, 'meta'), { recursive: true });
  const tmpgenJournal = JSON.parse(readFileSync(tmpgenJournalPath, 'utf8')) as {
    entries: Array<{ idx: number; tag: string; when: number; version?: string; breakpoints?: boolean }>;
    [k: string]: unknown;
  };
  const baselineEntry = tmpgenJournal.entries.find((e) => e.idx === 0);
  if (!baselineEntry) {
    console.log(pc.red(`[drizzleman] ✗ tmpgen journal has no idx=0 entry.`));
    cleanupDir(previewDir);
    cleanupDir(tmpgenDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  const generatedSqlBase = `${baselineEntry.tag}.sql`;
  const desiredSqlBase = `0000_${name}.sql`;
  // Copy generated SQL to canonical name in preview dir, with FK-safe
  // statement reorder applied (works around drizzle-kit 0.31.x's CREATE TABLE
  // → ALTER FK → CREATE INDEX ordering bug — see `reorderForFkSafety`).
  {
    const raw = readFileSync(path.join(tmpgenDir, generatedSqlBase), 'utf8');
    const reordered = reorderForFkSafety(raw);
    writeFileSync(path.join(previewDir, desiredSqlBase), reordered);
    if (reordered !== raw) {
      console.log(pc.dim('  reordered generated SQL (CREATE INDEX before ALTER ADD FK)'));
    }
  }
  // Copy snapshot.json.
  writeFileSync(
    path.join(previewDir, 'meta', '0000_snapshot.json'),
    readFileSync(path.join(tmpgenDir, 'meta', '0000_snapshot.json'), 'utf8'),
  );
  // Build a fresh journal for the preview with idx=0 = local schema baseline.
  const previewJournal = {
    ...tmpgenJournal,
    entries: [
      {
        idx: 0,
        version: baselineEntry.version ?? (tmpgenJournal as { version?: string }).version ?? '7',
        when: baselineEntry.when,
        tag: `0000_${name}`,
        breakpoints: baselineEntry.breakpoints ?? true,
      },
    ],
  };
  writeFileSync(path.join(previewDir, 'meta', '_journal.json'), JSON.stringify(previewJournal, null, 2));
  const baselineFile = path.join(previewDir, desiredSqlBase);
  const baselineHash = hashFile(baselineFile);
  console.log(pc.dim(`  0000 SQL: ${rel(baselineFile)} (${fmtBytes(statSync(baselineFile).size)})`));

  // ---- Step B: apply 0000 to schema DB via drizzle-kit migrate ----
  //
  // schema DB now physically holds the local-schema state, ready to be the
  // RHS oracle for Step D's `migra target schema` and Step V3's
  // `migra verify schema` comparisons.
  console.log(pc.bold('\n[drizzleman] Step B: drizzle-kit migrate → schema DB'));
  const schemaDbConfigPath = path.join(previewDir, '.drizzle.config.schemadb.json');
  writeFileSync(
    schemaDbConfigPath,
    JSON.stringify(
      {
        dialect: config.dialect,
        out: previewDir,
        dbCredentials: { url: schemaDbUrl },
      },
      null,
      2,
    ),
  );
  const migrateCode = await passthrough(['migrate', `--config=${schemaDbConfigPath}`]);
  if (migrateCode !== 0) {
    console.log(
      pc.red(
        `[drizzleman] ✗ drizzle-kit migrate (to schema DB) exited ${migrateCode}; schema DB may be partially populated.`,
      ),
    );
    cleanupDir(previewDir);
    cleanupDir(tmpgenDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return migrateCode;
  }
  console.log(pc.green('  ✓ schema DB now mirrors local schema'));

  // ---- Step C: migra <empty_verify> <target> → target.dump.sql ----
  //
  // verify DB is still empty (Step P0 asserted it). `migra <empty> <target>`
  // outputs the SQL needed to make empty look like target — equivalent to a
  // schema-only dump, but using the same schemainspect engine that drives
  // diff.sql (Step D) and the final check (Step V3). One tool, one set of
  // coverage gaps — easier to diagnose than mixing pg_dump + migra.
  const targetUrl = (() => {
    if (typeof config.dbCredentials.url === 'string' && config.dbCredentials.url) {
      return config.dbCredentials.url;
    }
    // Assemble from split creds (rare path; preTarget normally has a URL).
    const c = config.dbCredentials;
    const host = c.host ?? 'localhost';
    const port = c.port ?? 5432;
    const user = encodeURIComponent(String(c.user ?? ''));
    const password = c.password ? `:${encodeURIComponent(String(c.password))}` : '';
    const userinfo = user ? `${user}${password}@` : '';
    const db = encodeURIComponent(String(c.database ?? ''));
    const ssl = c.ssl ? `?sslmode=${encodeURIComponent(String(c.ssl))}` : '';
    return `postgres://${userinfo}${host}:${port}/${db}${ssl}`;
  })();
  const targetUrlNorm = normalizeUrlToPostgresql(targetUrl);

  console.log(pc.bold('\n[drizzleman] Step C: migra <empty_verify> <target> → target.dump.sql'));
  const targetDumpPath = path.join(previewDir, 'target.dump.sql');
  const dumpResult = await runMigraToFile(verifyDbUrl, targetUrlNorm, migraExcludes, targetDumpPath);
  if (!dumpResult.ok) {
    console.log(pc.red(`[drizzleman] ✗ migra (empty → target) failed: ${dumpResult.error}`));
    cleanupDir(previewDir);
    cleanupDir(tmpgenDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  console.log(
    pc.dim(`  target.dump.sql: ${rel(targetDumpPath)} (${fmtBytes(dumpResult.byteCount)})`),
  );

  // ---- Step D: migra <target> <schema_db> → {ts}_rebase_diff_only.sql ----
  //
  // Naming signals intent: this file is a RECORD of the target→schema delta
  // for human review (and manual `psql target -f`). It is NOT registered in
  // _journal.json and drizzleman never executes it — see CLAUDE.md G2.
  const diffOnlyBase = `${tsLabel}_rebase_diff_only.sql`;
  console.log(pc.bold(`\n[drizzleman] Step D: migra <target> <schema_db> → ${diffOnlyBase}`));
  const diffPath = path.join(previewDir, diffOnlyBase);
  const diffResult = await runMigraToFile(targetUrlNorm, schemaDbUrl, migraExcludes, diffPath);
  if (!diffResult.ok) {
    console.log(pc.red(`[drizzleman] ✗ migra (target → schema) failed: ${diffResult.error}`));
    cleanupDir(previewDir);
    cleanupDir(tmpgenDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  let diffBytes = diffResult.byteCount;
  console.log(pc.dim(`  ${diffOnlyBase}: ${rel(diffPath)} (${fmtBytes(diffBytes)})`));

  // Post-process: repair migra's incomplete enum-rename CHECK handling.
  try {
    const r = await repairEnumRenameCheckDeps(diffPath, config.dbCredentials);
    if (r.touchedEnums > 0) {
      diffBytes = statSync(diffPath).size;
      console.log(
        pc.dim(
          `  enum-rename dep fixup: ${r.touchedEnums} enum(s), ` +
            `+${r.injectedDefaultDrops} DROP DEFAULT / ` +
            `+${r.injectedCheckDrops} DROP CHECK / +${r.injectedCheckAdds} re-ADD CHECK / ` +
            `+${r.injectedIndexDrops} DROP INDEX / +${r.injectedIndexAdds} re-ADD INDEX`,
        ),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.yellow(`  ⚠ enum-rename CHECK fixup failed: ${msg} (continuing — V2 may still fail)`));
  }

  // Destructive-DDL scan (UX surface — does not gate, just reports).
  const destructive = scanDestructive(diffPath);
  if (hasAnyDestructive(destructive)) {
    const sum =
      destructive.dropTable +
      destructive.dropColumn +
      destructive.dropConstraint +
      destructive.dropIndex +
      destructive.dropType +
      destructive.dropOther +
      destructive.alterDrop;
    console.log(
      pc.red(`  ⚠ ${diffOnlyBase} contains ${sum} destructive DDL statement(s):`),
    );
    if (destructive.dropTable) console.log(pc.red(`      DROP TABLE       × ${destructive.dropTable}`));
    if (destructive.dropColumn) console.log(pc.red(`      DROP COLUMN      × ${destructive.dropColumn}`));
    if (destructive.dropConstraint) console.log(pc.red(`      DROP CONSTRAINT  × ${destructive.dropConstraint}`));
    if (destructive.dropIndex) console.log(pc.red(`      DROP INDEX       × ${destructive.dropIndex}`));
    if (destructive.dropType) console.log(pc.red(`      DROP TYPE        × ${destructive.dropType}`));
    if (destructive.alterDrop) console.log(pc.red(`      ALTER TABLE DROP × ${destructive.alterDrop}`));
    if (destructive.dropOther) console.log(pc.red(`      other DROP       × ${destructive.dropOther}`));
    console.log(
      pc.dim(
        `    (G2/G6: drizzleman will NEVER auto-apply this file to target. ` +
          `Review it, then manually \`psql target -f ${rel(diffPath)}\`.)`,
      ),
    );
  } else {
    console.log(pc.green(`  ✓ no destructive DDL in ${diffOnlyBase}`));
  }

  // ---- Step V: verify gate ----
  console.log(pc.bold('\n[drizzleman] Step V: verify (三命题闸口)'));
  // V1: pour target.dump.sql into verify DB → verify DB now ≈ target.
  console.log(pc.bold('  V1 (命题 ①): apply target.dump.sql to verify DB'));
  const v1 = await runSqlFile(verifyDbUrl, targetDumpPath);
  if (!v1.ok) {
    reportSqlFailure(v1, 'V1: target.dump.sql');
    cleanupDir(tmpgenDir);
    console.log(pc.red('\n[drizzleman] ✗ verify failed at V1; preview retained.'));
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  console.log(pc.green('    ✓ target dump applied to verify DB'));

  // V2: pour {ts}_rebase_diff_only.sql into verify DB → verify DB now ≈ target + diff.
  console.log(pc.bold(`  V2 (命题 ②): apply ${diffOnlyBase} to verify DB`));
  if (diffBytes === 0) {
    console.log(pc.dim('    (diff is empty — V2 trivially holds)'));
  } else {
    const v2 = await runSqlFile(verifyDbUrl, diffPath);
    if (!v2.ok) {
      reportSqlFailure(v2, `V2: ${diffOnlyBase}`);
      cleanupDir(tmpgenDir);
      console.log(pc.red('\n[drizzleman] ✗ verify failed at V2; preview retained.'));
      printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
      return 1;
    }
    console.log(pc.green('    ✓ diff applied to verify DB'));
  }

  // V3: final structural diff between verify DB and schema DB.
  console.log(pc.bold('  V3 (命题 ③): migra(verify, schema) expect ∅'));
  const v3 = await runMigra(verifyDbUrl, schemaDbUrl, migraExcludes);
  if (v3.error !== null) {
    console.log(pc.red(`    ✗ migra failed: ${v3.error}`));
    cleanupDir(tmpgenDir);
    console.log(pc.red('\n[drizzleman] ✗ verify failed at V3 (migra error); preview retained.'));
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  if (!v3.ok) {
    console.log(pc.red('    ✗ verify DB ≠ schema DB; migra diff:'));
    process.stderr.write(`\n----- V3 migra diff (verify → schema) -----\n${v3.sql}\n-------------------------------------------\n\n`);
    cleanupDir(tmpgenDir);
    console.log(pc.red('[drizzleman] ✗ verify failed at V3; preview retained.'));
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  console.log(pc.green('    ✓ verify DB ≡ schema DB (target + diff reconstructs schema)'));
  console.log(pc.green('\n[drizzleman] ✓ all three propositions pass'));

  // ---- Step H: render preview summary ----
  console.log(pc.bold('\n[drizzleman] Preview artifacts:'));
  for (const [label, file] of [
    [`  0000 ${pc.dim('(local schema baseline, will be marked applied)')}`, baselineFile],
    [`  target.dump.sql ${pc.dim('(target structure dump for verify; not promoted)')}`, targetDumpPath],
    [
      `  ${diffOnlyBase} ${pc.dim(
        '(target → schema delta; record-only — NOT in _journal.json. MUST be applied MANUALLY via `psql target -f`)',
      )}`,
      diffPath,
    ],
  ] as Array<[string, string]>) {
    const size = statSync(file).size;
    const lines = countLines(file);
    console.log(`${label}: ${pc.cyan(rel(file))}  ${pc.dim(`${fmtBytes(size)} / ${lines} lines`)}`);
  }

  // ---- Step I: decide ----
  if (verifyOnly) {
    console.log(pc.green('\n[drizzleman] ✓ --verify-only: gate passed; not applying.'));
    console.log(pc.dim(`  preview retained at ${rel(previewDir)}/.`));
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 0;
  }
  if (appliedError) {
    console.log(pc.red(`\n[drizzleman] ✗ cannot apply: failed to read ${tableLabel} (${appliedError}).`));
    console.log(pc.dim(`  preview retained at ${rel(previewDir)}/ for inspection.`));
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }

  if (!yes) {
    if (!process.stdin.isTTY) {
      console.log(
        pc.dim(`\nNon-TTY environment; preview retained at ${rel(previewDir)}/. Pass --yes to commit non-interactively.`),
      );
      printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
      return 0;
    }
    console.log('');
    const ok = await promptApply();
    if (!ok) {
      console.log(pc.dim(`[drizzleman] declined; preview retained at ${rel(previewDir)}/ for later inspection.`));
      printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
      return 0;
    }
  }

  // ---- Step J: apply ----
  console.log(pc.bold('\n[drizzleman] Applying:'));

  // J1: backup existing migrations + applied rows
  if (existingMigrationFiles.length > 0) {
    console.log(`  backing up ${existingMigrationFiles.length} entr${existingMigrationFiles.length === 1 ? 'y' : 'ies'} → ${rel(bakDir)}/`);
    mkdirSync(bakDir, { recursive: true });
    for (const entry of existingMigrationFiles) {
      renameSync(path.join(outDir, entry), path.join(bakDir, entry));
    }
    writeFileSync(
      path.join(bakDir, 'applied.json'),
      JSON.stringify({ table: tableLabel, rows: applied }, null, 2),
    );
    console.log(pc.green('  ✓ fs backup complete'));
  } else {
    console.log(pc.dim('  (no existing migrations to back up)'));
  }

  // J2: promote preview — move 0000 sql + meta into the migrations dir, plus
  // {ts}_rebase_diff_only.sql alongside them as a record-only artifact. The
  // diff is intentionally NOT added to _journal.json: drizzleman never runs
  // it, and there is no hash to register (the user `psql`'s it by hand and
  // the next normal `drizzle-kit generate` will roll any further drift into
  // a regular migration). target.dump.sql is moved to refDir for inspection.
  const finalDiffPath = path.join(outDir, diffOnlyBase);
  console.log(`  promoting preview → ${rel(outDir)}/`);
  try {
    renameSync(baselineFile, path.join(outDir, desiredSqlBase));
    const metaSrc = path.join(previewDir, 'meta');
    const metaDst = path.join(outDir, 'meta');
    if (!existsSync(metaDst)) mkdirSync(metaDst, { recursive: true });
    for (const f of readdirSync(metaSrc)) {
      renameSync(path.join(metaSrc, f), path.join(metaDst, f));
    }
    rmdirSync(metaSrc);
    renameSync(diffPath, finalDiffPath);

    if (existsSync(targetDumpPath)) {
      mkdirSync(refDir, { recursive: true });
      renameSync(targetDumpPath, path.join(refDir, 'target.dump.sql'));
    }
    cleanupDir(previewDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`  ✗ promotion failed mid-flight: ${msg}`));
    console.log(
      pc.red(
        `  Partial state: some files in ${rel(outDir)}/, some still in ${rel(previewDir)}/. Backup at ${rel(bakDir)}/ untouched. Recover manually.`,
      ),
    );
    cleanupDir(tmpgenDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  console.log(pc.green('  ✓ preview promoted'));

  // J3: reset DB migration table — only the 0000 hash is inserted as applied.
  // The rebase diff-only file is record-only (not journaled), so no further
  // hash gets registered for it; future drift lands in the next normal
  // generate cycle.
  console.log(`  resetting ${tableLabel} (backup → ${bakTableLabel})`);
  try {
    await resetAppliedToRebase(
      config.dialect,
      config.dbCredentials,
      table,
      { hash: baselineHash, createdAt: Date.now() },
      bakSlug,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`  ✗ DB reset failed: ${msg}`));
    console.log(
      pc.red(
        `  Filesystem is already swapped; DB rows untouched. Old rows in fs backup at ${rel(bakDir)}/applied.json. Investigate and retry manually.`,
      ),
    );
    cleanupDir(tmpgenDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  console.log(pc.green(`  ✓ ${tableLabel} reset; old rows preserved in ${bakTableLabel}`));

  cleanupDir(tmpgenDir);

  console.log(pc.green('\n[drizzleman] ✓ rebase complete.'));
  console.log(
    pc.bold(
      `  next: review ${pc.cyan(rel(finalDiffPath))} ` +
        `then ${pc.cyan(`psql <target> -f ${rel(finalDiffPath)}`)} manually.`,
    ),
  );
  console.log(
    pc.dim(
      `  ${diffOnlyBase} is record-only (NOT in _journal.json). drizzleman will NEVER ` +
        'execute it against target — CLAUDE.md G2.',
    ),
  );
  console.log(pc.dim(`  fs backup:  ${rel(bakDir)}/`));
  console.log(pc.dim(`  db backup:  ${bakTableLabel}`));
  if (existsSync(refDir)) console.log(pc.dim(`  reference:  ${rel(refDir)}/ (target.dump.sql)`));
  printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
  return 0;
}

function reportSqlFailure(r: Extract<RunSqlResult, { ok: false }>, label: string): void {
  console.log(pc.red(`    ✗ ${label} failed: ${r.error}`));
  if (r.code) console.log(pc.dim(`      SQLSTATE: ${r.code}`));
  if (r.snippet) console.log(pc.dim(`      near: ${r.snippet}`));
}

function printDbReminders(
  schemaDbUrl: string,
  verifyDbUrl: string,
  provisioned: { schema: string | null; verify: string | null },
): void {
  console.log(
    pc.dim(`\n  schema DB at ${pc.cyan(maskUrl(schemaDbUrl))} now contains a materialized copy of your local Drizzle schema.`),
  );
  console.log(
    pc.dim(`  verify DB at ${pc.cyan(maskUrl(verifyDbUrl))} was used to validate target-dump + diff against schema.`),
  );
  if (provisioned.schema || provisioned.verify) {
    console.log(pc.dim('  Both DBs were auto-created by drizzleman and are NOT auto-dropped. Clean up with:'));
    if (provisioned.schema) console.log(pc.dim(`    DROP DATABASE "${provisioned.schema}";`));
    if (provisioned.verify) console.log(pc.dim(`    DROP DATABASE "${provisioned.verify}";`));
  } else {
    console.log(pc.dim('  Drop / recycle both DBs yourself when finished inspecting.'));
  }
}
