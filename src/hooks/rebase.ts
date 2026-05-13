import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
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
  listPgColumnDefaults,
  listPgEnums,
  listPgExtensions,
  listStandalonePgIndexes,
  probeDb,
  type DbProbe,
  type PgEnumInfo,
} from '../db/probe.js';
import { passthrough } from '../passthrough.js';
import type { AppliedRow, DbCredentials, DrizzleConfig } from '../types.js';
import { targetUrl as renderUrl } from '../url.js';
import { preTarget } from './preTarget.js';

const PREVIEW_PREFIX = '.rebase-preview-';
const BAK_PREFIX = '.rebase-bak-';
const REF_PREFIX = '.rebase-ref-';
const SCHEMADB_INTRO_PREFIX = '.rebase-schemadbintro-';
const VERIFYDB_INTRO_PREFIX = '.rebase-verifyintro-';
const VERIFY_MIG_PREFIX = '.rebase-verifymig-';
const ENV_SCHEMA_DB_URL = 'DRIZZLEMAN_EMPTY_SCHEMA_DB_URL';
const ENV_VERIFY_DB_URL = 'DRIZZLEMAN_EMPTY_VERIFY_DB_URL';
const ENV_ADMIN_DB_URL = 'DRIZZLEMAN_ADMIN_DB_URL';

// Files that are NOT migrations themselves; they ship alongside the rebase
// preview as reference material. Promoted into `.rebase-ref-<ts>/` rather than
// the migrations dir proper.
const REF_FILE_NAMES = new Set(['schema.ts', 'relations.ts', 'schema.sql']);

const INTROSPECT_HEADER =
  '-- Current sql file was generated after introspecting the database';

// drizzle-kit introspect wraps its DDL inside `/* ... */` with a leading comment
// nudging the user to uncomment it before running. That default makes 0000
// useless as a fresh-environment baseline (drizzle-kit migrate would treat it
// as no-op SQL on a new empty DB). Strip the wrapper so 0000 is executable.
function uncommentIntrospectSql(sql: string): string {
  if (!sql.startsWith(INTROSPECT_HEADER)) return sql;
  const openIdx = sql.indexOf('/*');
  const closeIdx = sql.lastIndexOf('*/');
  if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) return sql;
  return `${sql.slice(openIdx + 2, closeIdx).trim()}\n`;
}

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
  // to drizzle-kit's introspect/generate (brocli would reject it as an unknown option).
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

function buildCredsArgs(creds: DbCredentials): string[] {
  if (typeof creds.url === 'string' && creds.url) return [`--url=${creds.url}`];
  const out: string[] = [];
  if (typeof creds.host === 'string') out.push(`--host=${creds.host}`);
  if (creds.port != null) out.push(`--port=${String(creds.port)}`);
  if (typeof creds.user === 'string') out.push(`--user=${creds.user}`);
  if (typeof creds.password === 'string') out.push(`--password=${creds.password}`);
  if (typeof creds.database === 'string') out.push(`--database=${creds.database}`);
  if (typeof creds.ssl === 'string') out.push(`--ssl=${creds.ssl}`);
  return out;
}

function buildSchemaArgs(schema: DrizzleConfig['schema']): string[] {
  if (!schema) return [];
  if (Array.isArray(schema)) return schema.map((s) => `--schema=${s}`);
  return [`--schema=${schema}`];
}

function maskUrl(url: string): string {
  // Re-use targetUrl's password masking by faking a minimal config.
  return renderUrl({ dialect: 'postgresql', out: '', dbCredentials: { url } });
}

// Render target DB connection as a URL for migra. migra speaks postgres:// URLs;
// it does not understand host/port/user-as-separate-args. If config has split
// creds, assemble them. (Existing drizzle-kit introspect already accepts both
// shapes via buildCredsArgs.)
function credsToUrl(creds: DbCredentials): string {
  if (typeof creds.url === 'string' && creds.url) return creds.url;
  const host = creds.host ?? 'localhost';
  const port = creds.port ?? 5432;
  const user = encodeURIComponent(String(creds.user ?? ''));
  const password = creds.password ? `:${encodeURIComponent(String(creds.password))}` : '';
  const userinfo = user ? `${user}${password}@` : '';
  const db = encodeURIComponent(String(creds.database ?? ''));
  const ssl = creds.ssl ? `?sslmode=${encodeURIComponent(String(creds.ssl))}` : '';
  return `postgres://${userinfo}${host}:${port}/${db}${ssl}`;
}

interface PreviewJournalEntry {
  idx: number;
  tag: string;
  when: number;
}

function readPreviewJournal(previewDir: string): PreviewJournalEntry[] {
  const journalPath = path.join(previewDir, 'meta', '_journal.json');
  if (!existsSync(journalPath)) return [];
  const raw = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries?: PreviewJournalEntry[];
  };
  return (raw.entries ?? []).slice().sort((a, b) => a.idx - b.idx);
}

function renameRebaseTag(previewDir: string, slug: string): { oldTag: string; newTag: string } {
  const journalPath = path.join(previewDir, 'meta', '_journal.json');
  const raw = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number; tag: string; [k: string]: unknown }>;
  };
  const baseline = raw.entries.find((e) => e.idx === 0);
  if (!baseline) throw new Error('introspect did not produce an idx=0 journal entry');
  const oldTag = baseline.tag;
  const newTag = `0000_${slug}`;
  if (oldTag !== newTag) {
    const oldSql = path.join(previewDir, `${oldTag}.sql`);
    const newSql = path.join(previewDir, `${newTag}.sql`);
    if (!existsSync(oldSql)) throw new Error(`introspect SQL file not found: ${oldSql}`);
    renameSync(oldSql, newSql);
    baseline.tag = newTag;
    writeFileSync(journalPath, JSON.stringify(raw, null, 2));
  }
  return { oldTag, newTag };
}

function cleanupDir(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// drizzle-kit 0.31.x generate emits statements in the order tables → FK ALTERs →
// indexes. That breaks any FK whose target column is unique only via a uniqueIndex
// (not via a column-level `.unique()` constraint): postgres rejects the FK at
// apply time with "no unique constraint matching given keys" (SQLSTATE 42830).
// Re-bucket the statements so all CREATE INDEX statements come before the FK
// ALTERs while preserving relative order within each bucket.
function reorderForFkSafety(sql: string): string {
  const SEP = '--> statement-breakpoint';
  const parts = sql.split(SEP);
  type Bucket = 'pre' | 'extension' | 'type' | 'table' | 'alter-default' | 'index' | 'fk' | 'other';
  const buckets: Record<Bucket, string[]> = {
    pre: [],
    extension: [],
    type: [],
    table: [],
    'alter-default': [],
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
    else if (
      /^\s*ALTER\s+TABLE\s+.+?\s+ALTER\s+COLUMN\s+"[^"]+"\s+(?:SET|DROP)\s+DEFAULT/is.test(trimmed)
    )
      buckets['alter-default'].push(raw);
    else if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s/i.test(trimmed)) buckets.index.push(raw);
    else if (/^\s*ALTER\s+TABLE\s+.+?\s+ADD\s+CONSTRAINT\s+"[^"]+"\s+FOREIGN\s+KEY/is.test(trimmed))
      buckets.fk.push(raw);
    else buckets.other.push(raw);
  }
  const ordered = [
    ...buckets.pre,
    ...buckets.extension,
    ...buckets.type,
    ...buckets.table,
    ...buckets['alter-default'],
    ...buckets.index,
    ...buckets.fk,
    ...buckets.other,
  ];
  return ordered.join(SEP);
}

// ---- snapshot diff ----

interface SnapshotJson {
  version?: string;
  dialect?: string;
  tables?: Record<string, SnapshotTable>;
  enums?: Record<string, unknown>;
  [k: string]: unknown;
}

interface SnapshotColumn {
  name?: string;
  type?: string;
  primaryKey?: boolean;
  notNull?: boolean;
  default?: unknown;
  [k: string]: unknown;
}

interface SnapshotCheck {
  name?: string;
  value?: string;
}

interface SnapshotTable {
  name?: string;
  schema?: string;
  columns?: Record<string, SnapshotColumn>;
  indexes?: Record<string, unknown>;
  foreignKeys?: Record<string, unknown>;
  checkConstraints?: Record<string, SnapshotCheck>;
  [k: string]: unknown;
}

interface ColumnSlot {
  entityKey: string;          // column:<schema>.<table>.<col>
  schema: string;
  table: string;
  col: string;
  spec: SnapshotColumn;
}

interface CheckSlot {
  entityKey: string;          // check:<schema>.<table>.<name>
  schema: string;
  table: string;
  name: string;
  value: string;
}

interface CheckChange {
  schema: string;
  table: string;
  name: string;
  targetValue: string;
  schemaDbValue: string;
}

interface SnapshotEnum {
  name?: string;
  schema?: string;
  values?: string[];
}

interface EnumValueChange {
  schema: string;
  name: string;
  added: string[];     // in schemaDb but not in target → emit ALTER TYPE ADD VALUE
  removed: string[];   // in target but not in schemaDb (postgres can't DROP VALUE; informational)
}

interface DiffSet {
  tables: string[];            // entity key: table:<schema>.<name>
  columns: ColumnSlot[];       // full column spec so we can synthesize ALTER ADD COLUMN
  indexes: string[];           // index:<schema>.<name>
  foreignKeys: string[];       // fk:<schema>.<table>.<constraint>
  enums: string[];             // enum:<schema>.<name>
  checks: CheckSlot[];         // check:<schema>.<table>.<name>, with predicate value
}

interface SnapshotDiff {
  onlyInSchemaDb: DiffSet;
  onlyInTarget: DiffSet;
  // Checks present on BOTH sides with the same name but different predicate text;
  // delta SQL needs to DROP target's version + ADD schema-db's version.
  changedChecks: CheckChange[];
  // Enums present on BOTH sides by name but with value-list mismatches;
  // delta SQL emits ALTER TYPE ADD VALUE IF NOT EXISTS for each added value.
  enumValueChanges: EnumValueChange[];
}

function emptyDiffSet(): DiffSet {
  return { tables: [], columns: [], indexes: [], foreignKeys: [], enums: [], checks: [] };
}

function normalizeCheckValue(v: string): string {
  return v.replace(/\s+/g, ' ').trim();
}

function tableSchema(t: SnapshotTable, key: string): string {
  if (typeof t.schema === 'string' && t.schema.length > 0) return t.schema;
  // key like "public.users" → schema = "public"
  const dot = key.indexOf('.');
  return dot >= 0 ? key.slice(0, dot) : 'public';
}

function tableName(t: SnapshotTable, key: string): string {
  if (typeof t.name === 'string' && t.name.length > 0) return t.name;
  const dot = key.indexOf('.');
  return dot >= 0 ? key.slice(dot + 1) : key;
}

// FK / index are compared by structural SIGNATURE (not by name).
// Reason: drizzle-kit push generates constraint / index names with a drizzle-specific
// convention (e.g. `<table>_<col>_<reftable>_<refcol>_fk`), while a target DB populated
// by hand-written migrations typically uses postgres defaults (`<table>_<col>_fkey`,
// `<table>_<col>_idx`). Naive name-keyed diff inflates schema.sql with these renames.
// Signature-keyed diff treats two FKs/indexes as equivalent iff they reference the
// same columns with the same semantics, regardless of name.

interface SnapshotFk {
  name?: string;
  tableFrom?: string;
  tableTo?: string;
  schemaTo?: string;
  columnsFrom?: string[];
  columnsTo?: string[];
  onDelete?: string;
  onUpdate?: string;
}

interface SnapshotIdxCol {
  expression?: string;
  isExpression?: boolean;
  asc?: boolean;
  nulls?: string;
}

interface SnapshotIdx {
  name?: string;
  columns?: Array<SnapshotIdxCol | string>;
  isUnique?: boolean;
  method?: string;
  where?: string;
}

function normalizeOnAction(v: unknown): string {
  const s = String(v ?? '').toLowerCase().trim();
  return s.length > 0 ? s : 'no action';
}

function fkSignature(fk: SnapshotFk, fromSchema: string): string {
  const tableFrom = String(fk.tableFrom ?? '');
  const tableTo = String(fk.tableTo ?? '');
  const schemaTo = (() => {
    const s = String(fk.schemaTo ?? '');
    return s.length > 0 ? s : (fromSchema || 'public');
  })();
  const cFrom = Array.isArray(fk.columnsFrom) ? fk.columnsFrom.map(String).join(',') : '';
  const cTo = Array.isArray(fk.columnsTo) ? fk.columnsTo.map(String).join(',') : '';
  const onDelete = normalizeOnAction(fk.onDelete);
  const onUpdate = normalizeOnAction(fk.onUpdate);
  return `${tableFrom}(${cFrom})->${schemaTo}.${tableTo}(${cTo})|del=${onDelete}|upd=${onUpdate}`;
}

function indexSignature(idx: SnapshotIdx, schema: string, table: string): string {
  const cols = Array.isArray(idx.columns) ? idx.columns : [];
  const colSigs = cols.map((c) => {
    if (typeof c === 'string') return c;
    const expr = String(c.expression ?? '');
    const isExpr = Boolean(c.isExpression);
    const asc = c.asc === false ? 'desc' : 'asc';
    // Postgres default null ordering: ASC=last, DESC=first. Normalize so two indexes
    // that differ only by an explicit-vs-default null clause still compare equal.
    const nulls = String(c.nulls ?? (asc === 'asc' ? 'last' : 'first')).toLowerCase();
    return `${isExpr ? `(${expr})` : expr}@${asc}/${nulls}`;
  }).join(',');
  const unique = Boolean(idx.isUnique);
  const method = String(idx.method ?? 'btree').toLowerCase();
  const where = String(idx.where ?? '').replace(/\s+/g, ' ').trim();
  return `${schema}.${table}[${colSigs}]|unique=${unique}|method=${method}|where=${where}`;
}

interface TableEntities {
  tableKey: string;
  schema: string;
  table: string;
  columnSlots: Map<string, ColumnSlot>;   // colName → full column slot (spec preserved)
  fkSigs: Map<string, string>;            // structural signature → fk entityKey
  indexSigs: Map<string, string>;         // structural signature → index entityKey
  checkSlots: Map<string, CheckSlot>;     // checkName → full check slot (value preserved)
}

function tableEntities(t: SnapshotTable, key: string): TableEntities {
  const schema = tableSchema(t, key);
  const table = tableName(t, key);
  const qualified = `${schema}.${table}`;
  const tableKey = `table:${qualified}`;

  const columnSlots = new Map<string, ColumnSlot>();
  for (const [c, spec] of Object.entries(t.columns ?? {})) {
    columnSlots.set(c, {
      entityKey: `column:${qualified}.${c}`,
      schema,
      table,
      col: c,
      spec: spec as SnapshotColumn,
    });
  }

  const fkSigs = new Map<string, string>();
  for (const [fkName, fk] of Object.entries(t.foreignKeys ?? {})) {
    const sig = fkSignature(fk as SnapshotFk, schema);
    fkSigs.set(sig, `fk:${qualified}.${fkName}`);
  }

  const indexSigs = new Map<string, string>();
  for (const [idxName, idx] of Object.entries(t.indexes ?? {})) {
    const sig = indexSignature(idx as SnapshotIdx, schema, table);
    indexSigs.set(sig, `index:${schema}.${idxName}`);
  }

  const checkSlots = new Map<string, CheckSlot>();
  for (const [checkName, spec] of Object.entries(t.checkConstraints ?? {})) {
    checkSlots.set(checkName, {
      entityKey: `check:${qualified}.${checkName}`,
      schema,
      table,
      name: checkName,
      value: String((spec as SnapshotCheck)?.value ?? ''),
    });
  }

  return { tableKey, schema, table, columnSlots, fkSigs, indexSigs, checkSlots };
}

function diffSnapshots(target: SnapshotJson, schemaDb: SnapshotJson): SnapshotDiff {
  const onlyInTarget = emptyDiffSet();
  const onlyInSchemaDb = emptyDiffSet();
  const changedChecks: CheckChange[] = [];

  const tT = target.tables ?? {};
  const tS = schemaDb.tables ?? {};

  // Tables (by qualified key); columns/checks by name (with full spec); fks/indexes by structural signature.
  for (const [key, def] of Object.entries(tT)) {
    const ents = tableEntities(def, key);
    if (!(key in tS)) {
      onlyInTarget.tables.push(ents.tableKey);
      for (const slot of ents.columnSlots.values()) onlyInTarget.columns.push(slot);
      for (const v of ents.indexSigs.values()) onlyInTarget.indexes.push(v);
      for (const v of ents.fkSigs.values()) onlyInTarget.foreignKeys.push(v);
      for (const slot of ents.checkSlots.values()) onlyInTarget.checks.push(slot);
    } else {
      const sEnts = tableEntities(tS[key]!, key);
      for (const [c, slot] of ents.columnSlots) {
        if (!sEnts.columnSlots.has(c)) onlyInTarget.columns.push(slot);
      }
      for (const [sig, k] of ents.indexSigs) if (!sEnts.indexSigs.has(sig)) onlyInTarget.indexes.push(k);
      for (const [sig, k] of ents.fkSigs) if (!sEnts.fkSigs.has(sig)) onlyInTarget.foreignKeys.push(k);
      for (const [name, slot] of ents.checkSlots) {
        const sSlot = sEnts.checkSlots.get(name);
        if (!sSlot) {
          onlyInTarget.checks.push(slot);
        } else if (normalizeCheckValue(slot.value) !== normalizeCheckValue(sSlot.value)) {
          changedChecks.push({
            schema: slot.schema,
            table: slot.table,
            name,
            targetValue: slot.value,
            schemaDbValue: sSlot.value,
          });
        }
      }
    }
  }
  for (const [key, def] of Object.entries(tS)) {
    const ents = tableEntities(def, key);
    if (!(key in tT)) {
      onlyInSchemaDb.tables.push(ents.tableKey);
      for (const slot of ents.columnSlots.values()) onlyInSchemaDb.columns.push(slot);
      for (const v of ents.indexSigs.values()) onlyInSchemaDb.indexes.push(v);
      for (const v of ents.fkSigs.values()) onlyInSchemaDb.foreignKeys.push(v);
      for (const slot of ents.checkSlots.values()) onlyInSchemaDb.checks.push(slot);
    } else {
      const tEnts = tableEntities(tT[key]!, key);
      for (const [c, slot] of ents.columnSlots) {
        if (!tEnts.columnSlots.has(c)) onlyInSchemaDb.columns.push(slot);
      }
      for (const [sig, k] of ents.indexSigs) if (!tEnts.indexSigs.has(sig)) onlyInSchemaDb.indexes.push(k);
      for (const [sig, k] of ents.fkSigs) if (!tEnts.fkSigs.has(sig)) onlyInSchemaDb.foreignKeys.push(k);
      for (const [name, slot] of ents.checkSlots) {
        if (!tEnts.checkSlots.has(name)) onlyInSchemaDb.checks.push(slot);
        // value-changed already pushed during the target-side iteration above
      }
    }
  }

  // Enums — by qualified name for entity existence; value-list diffs for in-both.
  const eT = (target.enums ?? {}) as Record<string, SnapshotEnum>;
  const eS = (schemaDb.enums ?? {}) as Record<string, SnapshotEnum>;
  const enumValueChanges: EnumValueChange[] = [];
  for (const k of Object.keys(eT)) {
    if (!(k in eS)) {
      onlyInTarget.enums.push(`enum:${k}`);
      continue;
    }
    const tVals = Array.isArray(eT[k]?.values) ? eT[k]!.values! : [];
    const sVals = Array.isArray(eS[k]?.values) ? eS[k]!.values! : [];
    const added = sVals.filter((v) => !tVals.includes(v));
    const removed = tVals.filter((v) => !sVals.includes(v));
    if (added.length + removed.length > 0) {
      const dot = k.indexOf('.');
      const schema = dot >= 0 ? k.slice(0, dot) : 'public';
      const name = dot >= 0 ? k.slice(dot + 1) : k;
      enumValueChanges.push({ schema, name, added, removed });
    }
  }
  for (const k of Object.keys(eS)) {
    if (!(k in eT)) onlyInSchemaDb.enums.push(`enum:${k}`);
  }

  return { onlyInTarget, onlyInSchemaDb, changedChecks, enumValueChanges };
}

// ---- SQL chunker ----

interface SqlChunk {
  key: string;          // entity key, e.g. table:public.users
  kind: 'enum' | 'enum-value-add' | 'table' | 'index' | 'fk' | 'column' | 'check-drop' | 'check-add';
  sql: string;          // full statement including trailing semicolon
  ownerTableKey?: string; // for fk/index/column/check: table:<schema>.<name> they belong to
}

const reCreateEnum =
  /^\s*CREATE\s+TYPE\s+(?:"([^"]+)"\.)?"([^"]+)"\s+AS\s+ENUM/i;
const reCreateTable =
  /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"\.)?"([^"]+)"/i;
const reCreateIndex =
  /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"\s+ON\s+(?:"([^"]+)"\.)?"([^"]+)"/i;
const reAlterAddFk =
  /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)"\.)?"([^"]+)"\s+ADD\s+CONSTRAINT\s+"([^"]+)"\s+FOREIGN\s+KEY/i;

function splitTopLevelStatements(sql: string): string[] {
  // drizzle-kit introspect uses --> statement-breakpoint comments to delimit;
  // it also writes one statement per top-level `;`. We split on statement-breakpoint
  // marker if present, else on top-level `;`.
  const out: string[] = [];
  if (sql.includes('--> statement-breakpoint')) {
    for (const chunk of sql.split(/--> statement-breakpoint/g)) {
      const t = chunk.trim();
      if (t) out.push(t);
    }
    return out;
  }
  // Fallback: scan for top-level `;` (not inside () or '' or "")
  let depth = 0;
  let inSq = false;
  let inDq = false;
  let inLineComment = false;
  let inBlockComment = false;
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inSq) { if (c === "'") inSq = false; continue; }
    if (inDq) { if (c === '"') inDq = false; continue; }
    if (c === '-' && next === '-') { inLineComment = true; i++; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (c === "'") { inSq = true; continue; }
    if (c === '"') { inDq = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && depth === 0) {
      const stmt = sql.slice(start, i + 1).trim();
      if (stmt) out.push(stmt);
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function chunkSql(sql: string): SqlChunk[] {
  const stmts = splitTopLevelStatements(sql);
  const chunks: SqlChunk[] = [];
  for (const raw of stmts) {
    // Ensure each chunk ends with a semicolon.
    const sqlWithSemi = raw.trimEnd().endsWith(';') ? raw : `${raw};`;
    let m: RegExpMatchArray | null;
    if ((m = sqlWithSemi.match(reCreateEnum))) {
      const schema = m[1] ?? 'public';
      const name = m[2]!;
      chunks.push({ key: `enum:${schema}.${name}`, kind: 'enum', sql: sqlWithSemi });
      continue;
    }
    if ((m = sqlWithSemi.match(reCreateTable))) {
      const schema = m[1] ?? 'public';
      const name = m[2]!;
      chunks.push({ key: `table:${schema}.${name}`, kind: 'table', sql: sqlWithSemi });
      continue;
    }
    if ((m = sqlWithSemi.match(reCreateIndex))) {
      const idxName = m[1]!;
      const tableSchemaName = m[2] ?? 'public';
      const tableName = m[3]!;
      chunks.push({
        key: `index:${tableSchemaName}.${idxName}`,
        kind: 'index',
        sql: sqlWithSemi,
        ownerTableKey: `table:${tableSchemaName}.${tableName}`,
      });
      continue;
    }
    if ((m = sqlWithSemi.match(reAlterAddFk))) {
      const tableSchemaName = m[1] ?? 'public';
      const tableName = m[2]!;
      const fkName = m[3]!;
      chunks.push({
        key: `fk:${tableSchemaName}.${tableName}.${fkName}`,
        kind: 'fk',
        sql: sqlWithSemi,
        ownerTableKey: `table:${tableSchemaName}.${tableName}`,
      });
      continue;
    }
    // Unmatched statement (e.g. CREATE SCHEMA, ALTER TABLE ENABLE RLS, comments-only)
    // → skip; they don't carry an entity identity we'd diff on.
  }
  return chunks;
}

// ---- artifact builders ----

// FK-safe + check-aware execution order. Within each kind, stable sort preserves
// the introspect-source ordering. Critical orderings:
//   - enum-value-add FIRST: new enum values must exist before any later statement
//     (table create / check predicate) can reference them.
//   - check-drop next: a value-changed check on a column we're about to modify
//     must be dropped before column / table mutations.
//   - enum (CREATE TYPE) → table → column: enums precede tables; tables precede
//     ALTER ADD COLUMN.
//   - index → fk: a FK referencing a uniqueIndex-only-unique target needs the
//     index to already exist (postgres SQLSTATE 42830).
//   - check-add LAST: new check predicates may reference newly-added columns
//     and / or newly-added enum values.
const KIND_ORDER: Record<SqlChunk['kind'], number> = {
  'enum-value-add': 0,
  'check-drop': 1,
  enum: 2,
  table: 3,
  column: 4,
  index: 5,
  fk: 6,
  'check-add': 7,
};

function qIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function qTable(schema: string, table: string): string {
  return `${qIdent(schema)}.${qIdent(table)}`;
}

function formatDefault(d: unknown): string | null {
  if (d === null || d === undefined) return null;
  // drizzle stores DEFAULT expressions verbatim (postgres-side text); use as-is.
  return String(d);
}

function buildAddColumnSql(c: ColumnSlot): string {
  const t = c.spec.type ?? 'text';
  const parts = [`ALTER TABLE ${qTable(c.schema, c.table)} ADD COLUMN ${qIdent(c.col)} ${t}`];
  const def = formatDefault(c.spec.default);
  if (def !== null) parts.push(`DEFAULT ${def}`);
  if (c.spec.notNull) parts.push('NOT NULL');
  return `${parts.join(' ')};`;
}

function buildDropConstraintSql(schema: string, table: string, name: string): string {
  return `ALTER TABLE ${qTable(schema, table)} DROP CONSTRAINT ${qIdent(name)};`;
}

function buildAddCheckSql(c: { schema: string; table: string; name: string; value: string }): string {
  return `ALTER TABLE ${qTable(c.schema, c.table)} ADD CONSTRAINT ${qIdent(c.name)} CHECK (${c.value});`;
}

function buildAddEnumValueSql(schema: string, name: string, value: string): string {
  // Quote SQL string literal (escape single quotes).
  const esc = value.replace(/'/g, "''");
  return `ALTER TYPE ${qTable(schema, name)} ADD VALUE IF NOT EXISTS '${esc}';`;
}

// Shared SQL composition for both delta (apply to target) and schema.sql (reference).
// `side` picks which diff slice to consume; `includeChangedChecks` only enables the
// DROP+ADD pair for value-changed checks (these belong in delta, not in schema.sql).
function buildSqlForSide(
  chunks: SqlChunk[],
  diff: SnapshotDiff,
  side: 'schemaDb' | 'target',
  includeChangedChecks: boolean,
): string {
  const diffSet = side === 'schemaDb' ? diff.onlyInSchemaDb : diff.onlyInTarget;
  // Indexes whose entity key (= name) appears in BOTH onlyInTarget AND
  // onlyInSchemaDb are *same-name-different-signature* collisions: target has
  // index "foo" with shape A, local schema has index "foo" with shape B.
  // For the delta (schemaDb side), we need to DROP target's "foo" before
  // CREATE-ing the new shape — otherwise apply on a verify DB that already
  // ran 0000 fails with "relation already exists".
  const collidingIndexKeys = new Set<string>();
  if (side === 'schemaDb') {
    const targetIdxSet = new Set(diff.onlyInTarget.indexes);
    for (const k of diff.onlyInSchemaDb.indexes) {
      if (targetIdxSet.has(k)) collidingIndexKeys.add(k);
    }
  }
  const wantedTables = new Set(diffSet.tables);
  const wantedIndexes = new Set(diffSet.indexes);
  const wantedFks = new Set(diffSet.foreignKeys);
  const wantedEnums = new Set(diffSet.enums);

  const all: SqlChunk[] = [];

  // Entity chunks (enum / table / index / fk) from the source SQL file.
  // Note: drizzle-kit introspect emits indexes and FKs as SEPARATE statements
  // (CREATE INDEX … / ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY …), even for
  // brand-new tables. So we ALWAYS emit them when in the wanted set — no
  // "skip if owner table being created" shortcut. CHECK constraints and column
  // defs ARE inlined in CREATE TABLE, so those still get skipped below.
  for (const c of chunks) {
    if (c.kind === 'enum' && wantedEnums.has(c.key)) all.push(c);
    else if (c.kind === 'table' && wantedTables.has(c.key)) all.push(c);
    else if (c.kind === 'index' && wantedIndexes.has(c.key)) {
      // For colliding indexes (same name, different shape on each side),
      // prepend DROP INDEX IF EXISTS so 0001 applies cleanly on a verify
      // DB that already has the old shape from 0000.
      if (collidingIndexKeys.has(c.key)) {
        const m = c.key.match(/^index:([^.]+)\.(.+)$/);
        if (m) {
          const schema = m[1]!;
          const name = m[2]!;
          all.push({
            ...c,
            sql: `DROP INDEX IF EXISTS ${qTable(schema, name)};\n--> statement-breakpoint\n${c.sql}`,
          });
          continue;
        }
      }
      all.push(c);
    } else if (c.kind === 'fk' && wantedFks.has(c.key)) all.push(c);
  }

  // Synthetic columns: only for tables present on BOTH sides (else the full
  // CREATE TABLE already covers them).
  for (const slot of diffSet.columns) {
    const ownerKey = `table:${slot.schema}.${slot.table}`;
    if (wantedTables.has(ownerKey)) continue;
    all.push({
      key: slot.entityKey,
      kind: 'column',
      sql: buildAddColumnSql(slot),
      ownerTableKey: ownerKey,
    });
  }

  // Synthetic check-adds: same ownership filter.
  for (const slot of diffSet.checks) {
    const ownerKey = `table:${slot.schema}.${slot.table}`;
    if (wantedTables.has(ownerKey)) continue;
    all.push({
      key: slot.entityKey,
      kind: 'check-add',
      sql: buildAddCheckSql(slot),
      ownerTableKey: ownerKey,
    });
  }

  // Enum value additions (only for delta): postgres can't DROP VALUE, so we
  // never emit anything for the schema.sql side here. Each added value is its
  // own ALTER TYPE statement guarded by IF NOT EXISTS.
  if (includeChangedChecks) {
    for (const change of diff.enumValueChanges) {
      for (const v of change.added) {
        all.push({
          key: `enum-value-add:${change.schema}.${change.name}.${v}`,
          kind: 'enum-value-add',
          sql: buildAddEnumValueSql(change.schema, change.name, v),
        });
      }
    }
  }

  // Value-changed checks (only for delta): DROP target's predicate + ADD schema-db's.
  if (includeChangedChecks) {
    for (const change of diff.changedChecks) {
      const ownerKey = `table:${change.schema}.${change.table}`;
      all.push({
        key: `check-drop:${change.schema}.${change.table}.${change.name}`,
        kind: 'check-drop',
        sql: buildDropConstraintSql(change.schema, change.table, change.name),
        ownerTableKey: ownerKey,
      });
      all.push({
        key: `check-add:${change.schema}.${change.table}.${change.name}`,
        kind: 'check-add',
        sql: buildAddCheckSql({
          schema: change.schema,
          table: change.table,
          name: change.name,
          value: change.schemaDbValue,
        }),
        ownerTableKey: ownerKey,
      });
    }
  }

  all.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  return all.map((c) => c.sql).join('\n--> statement-breakpoint\n');
}

function buildDeltaSql(schemaDbChunks: SqlChunk[], diff: SnapshotDiff): string {
  return buildSqlForSide(schemaDbChunks, diff, 'schemaDb', true);
}

const SCHEMA_SQL_EMPTY = `-- schema.sql
-- (generated by drizzleman rebase)
-- target DB structure matches local schema; nothing to add.
`;

function buildSchemaSql(targetChunks: SqlChunk[], diff: SnapshotDiff): string {
  const body = buildSqlForSide(targetChunks, diff, 'target', false);
  if (body.length === 0) return SCHEMA_SQL_EMPTY;
  const header = `-- schema.sql
-- (generated by drizzleman rebase)
-- DDL for entities present in target DB but missing from your local Drizzle schema.
-- Translate these to Drizzle DSL and add them to your schema files, then re-run rebase.
`;
  return `${header}\n${body}\n`;
}

function fmtDiffSet(d: DiffSet): string {
  return `tables=${d.tables.length} columns=${d.columns.length} indexes=${d.indexes.length} fks=${d.foreignKeys.length} checks=${d.checks.length} enums=${d.enums.length}`;
}

function readSnapshot(dir: string): SnapshotJson {
  const p = path.join(dir, 'meta', '0000_snapshot.json');
  return JSON.parse(readFileSync(p, 'utf8')) as SnapshotJson;
}

// drizzle-kit 0.31.x introspect emits unreliable opclass annotations on btree
// index columns — it picks ONE opclass per index (apparently from the first
// column's column type) and replicates it to every column in the same index.
// Postgres then rejects the index at apply time when the opclass doesn't
// accept a later column's type:
//   ERROR: operator class "text_ops" does not accept data type <enum>
//   ERROR: operator class "uuid_ops" does not accept data type <enum>
//   etc.  [SQLSTATE 42804]
// The DB-side index metadata is fine — each column has its proper default
// opclass (`enum_ops` for enums, `text_ops` for text, `uuid_ops` for uuid,
// etc.); only the introspected SQL is mis-serialized.
//
// Strategy: strip EVERY explicit opclass annotation from CREATE INDEX
// column lists, letting Postgres pick each column's default opclass on
// apply. This is safe because:
//   1. drizzle schema DSL doesn't expose opclass control, so a target DB
//      populated by drizzle migrations has default opclasses everywhere.
//   2. If a hand-written migration intentionally chose a non-default
//      opclass (e.g., `text_pattern_ops` for LIKE 'prefix%'), the verify
//      gate's migra step will flag the resulting opclass diff explicitly —
//      visible signal beats silently-broken 0000.
function stripIndexOpclasses(sql: string): string {
  // Match a CREATE INDEX statement's "USING <method> (col-list)" portion.
  // Column lists with function expressions (nested parens) won't match this
  // simple pattern — drizzle-kit doesn't emit explicit opclasses on
  // expression columns anyway, so it's a non-issue.
  const INDEX_RE =
    /(CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"[^"]+"\s+ON\s+(?:"[^"]+"\.)?"[^"]+"\s+USING\s+\w+\s*\()([^)]*)(\))/gi;

  return sql.replace(INDEX_RE, (_match, head, colList, tail) => {
    const entries = (colList as string)
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e.length > 0);

    const rewritten = entries.map((entry) => {
      // entry shape: `"col" [opclass] [ASC|DESC] [NULLS FIRST|LAST]`.
      // Drop the word IMMEDIATELY after the quoted column name unless it's
      // a sort modifier.
      const m = entry.match(/^("[^"]+")\s+([A-Za-z_][A-Za-z0-9_]*)(.*)$/);
      if (!m) return entry;
      const quoted = m[1]!;
      const wordAfter = m[2]!;
      const after = m[3]!;
      if (/^(asc|desc|nulls)$/i.test(wordAfter)) return entry;
      // Treat wordAfter as an opclass and drop it.
      return `${quoted}${after}`;
    });

    return `${head}${rewritten.join(', ')}${tail}`;
  });
}

// ---- pg_indexes supplement (workaround for drizzle-kit introspect dropping indexes) ----

interface ParsedIndexDef {
  schema: string;
  table: string;
  name: string;
  isUnique: boolean;
  method: string;
  columns: Array<{
    expression: string;
    isExpression: boolean;
    asc: boolean;
    nulls: string;
  }>;
  where: string;
}

// Parse `pg_get_indexdef` output for the common shapes drizzle-kit introspect
// is most likely to drop: simple CREATE INDEX on one or more named columns,
// optional WHERE clause. Returns null for shapes we don't confidently
// understand (expression indexes with nested function calls, INCLUDE clauses,
// etc.) — those go into 0000 as raw SQL only, snapshot stays as introspect
// left it. SQL-only supplement still keeps V1 honest; snapshot mismatch
// surfaces as a migra diff at V2 rather than a runtime error.
function parseSimpleCreateIndex(indexDef: string): ParsedIndexDef | null {
  const m = indexDef.match(
    /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"?([^\s".]+)"?\s+)ON\s+(?:ONLY\s+)?(?:"?([^\s".]+)"?\.)?"?([^\s".]+)"?\s+USING\s+(\w+)\s+\(([^()]+)\)\s*(?:WHERE\s+(.+))?$/i,
  );
  if (!m) return null;
  const isUnique = Boolean(m[1]);
  const name = m[2]!;
  const schema = m[3] ?? 'public';
  const table = m[4]!;
  const method = m[5]!.toLowerCase();
  const colListRaw = m[6]!;
  const whereRaw = m[7] ?? '';

  const columns: ParsedIndexDef['columns'] = [];
  for (const rawEntry of colListRaw.split(',')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    // Each entry: <col> [<opclass>] [ASC|DESC] [NULLS FIRST|LAST]
    // Bare column names may be quoted or unquoted.
    const e = entry.match(
      /^"?([^\s",]+)"?(?:\s+[A-Za-z_][A-Za-z0-9_]*)?(?:\s+(ASC|DESC))?(?:\s+NULLS\s+(FIRST|LAST))?$/i,
    );
    if (!e) return null; // unparseable column entry → bail
    const colName = e[1]!;
    const sortDir = (e[2] ?? 'ASC').toUpperCase();
    const asc = sortDir !== 'DESC';
    const nulls = (e[3] ?? (asc ? 'LAST' : 'FIRST')).toLowerCase();
    columns.push({ expression: colName, isExpression: false, asc, nulls });
  }
  if (columns.length === 0) return null;

  // Strip outer parens if present on the WHERE predicate, but only one level —
  // matches how drizzle-kit's introspect serializes them.
  const where = whereRaw.replace(/^\s*\((.*)\)\s*$/, '$1').trim();

  return { schema, table, name, isUnique, method, columns, where };
}

// Builds the SnapshotIdx entry that drizzle-kit's own snapshot format
// expects. The `opclass` field is informational (not part of our diff
// signature), so leaving it empty keeps the supplement minimal. Other fields
// match the shape we observed in real introspect snapshots.
function buildSnapshotIndexEntry(idx: ParsedIndexDef): Record<string, unknown> {
  return {
    name: idx.name,
    columns: idx.columns.map((c) => ({
      expression: c.expression,
      asc: c.asc,
      nulls: c.nulls,
      opclass: '',
      isExpression: c.isExpression,
    })),
    isUnique: idx.isUnique,
    concurrently: false,
    method: idx.method,
    where: idx.where,
    with: {},
  };
}

interface IndexSupplementResult {
  // Indexes whose SQL in 0000 was REPLACED with the pg_get_indexdef version
  // because drizzle-kit's serialization is unreliable (drops DESC / NULLS
  // modifiers, mangles opclasses, etc.).
  replaced: number;
  // Indexes APPENDED to 0000 because drizzle-kit dropped them entirely.
  appended: number;
  // Of the appended ones, how many also made it into the snapshot.
  appendedToSnapshot: number;
  // Of the appended ones, how many ended up SQL-only because parsing failed.
  sqlOnly: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function supplementMissingIndexes(
  previewDir: string,
  baselineFile: string,
  config: DrizzleConfig,
): Promise<IndexSupplementResult> {
  const snapshotPath = path.join(previewDir, 'meta', '0000_snapshot.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as SnapshotJson & {
    tables?: Record<string, SnapshotTable & { indexes?: Record<string, unknown> }>;
  };

  // What indexes does drizzle-kit introspect already know about?
  const known = new Set<string>();
  for (const [tableKey, tbl] of Object.entries(snapshot.tables ?? {})) {
    const schema = tableSchema(tbl, tableKey);
    const table = tableName(tbl, tableKey);
    for (const idxName of Object.keys((tbl as SnapshotTable).indexes ?? {})) {
      known.add(`${schema}.${table}.${idxName}`);
    }
  }

  const targetIndexes = await listStandalonePgIndexes(config.dbCredentials);

  const result: IndexSupplementResult = {
    replaced: 0,
    appended: 0,
    appendedToSnapshot: 0,
    sqlOnly: 0,
  };

  let body = readFileSync(baselineFile, 'utf8');
  const toAppend: string[] = [];

  for (const idx of targetIndexes) {
    const canonical = idx.indexDef.trim().replace(/;\s*$/, '');
    // Drizzle-kit introspect emits each CREATE INDEX as a single line ending
    // with `;--> statement-breakpoint`. Match by exact index name and
    // replace the entire statement (preserving the trailing breakpoint
    // marker) with the pg_get_indexdef version — that is the only
    // authoritative source for DESC / NULLS / partial-WHERE clauses, all of
    // which drizzle-kit 0.31.x serializes incorrectly on enough columns to
    // make 0000 un-applyable.
    const replaceRe = new RegExp(
      `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?"${escapeRegExp(
        idx.indexName,
      )}"\\s+ON\\s+[^;\\n]+;(?:--> statement-breakpoint)?$`,
      'gim',
    );
    if (replaceRe.test(body)) {
      replaceRe.lastIndex = 0;
      body = body.replace(replaceRe, () => `${canonical};--> statement-breakpoint`);
      result.replaced++;
      continue;
    }

    // Not present at all — drizzle-kit dropped this index. Append + try
    // to supplement snapshot so Step E's diff stays consistent.
    if (
      !known.has(`${idx.schemaName}.${idx.tableName}.${idx.indexName}`)
    ) {
      toAppend.push(`${canonical};`);
      result.appended++;
      const parsed = parseSimpleCreateIndex(idx.indexDef);
      if (parsed) {
        const tableKey = `${parsed.schema}.${parsed.table}`;
        const t = snapshot.tables?.[tableKey];
        if (t) {
          if (!t.indexes) t.indexes = {};
          (t.indexes as Record<string, unknown>)[parsed.name] =
            buildSnapshotIndexEntry(parsed);
          result.appendedToSnapshot++;
          continue;
        }
      }
      result.sqlOnly++;
    }
  }

  if (toAppend.length > 0) {
    if (!body.endsWith('\n')) body += '\n';
    body += `${toAppend.join('\n--> statement-breakpoint\n')}\n`;
  }

  writeFileSync(baselineFile, body);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

  return result;
}

// ---- pg_enum supplement (workaround for drizzle-kit dropping enum values) ----

interface EnumSupplementResult {
  replaced: number;
  appended: number;
}

async function supplementEnumValues(
  previewDir: string,
  baselineFile: string,
  config: DrizzleConfig,
): Promise<EnumSupplementResult> {
  const snapshotPath = path.join(previewDir, 'meta', '0000_snapshot.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as SnapshotJson & {
    enums?: Record<string, { name?: string; schema?: string; values?: string[] }>;
  };
  const targetEnums = await listPgEnums(config.dbCredentials);

  const result: EnumSupplementResult = { replaced: 0, appended: 0 };
  let body = readFileSync(baselineFile, 'utf8');
  const toAppend: string[] = [];

  for (const e of targetEnums) {
    const valuesSqlList = e.values
      .map((v) => `'${v.replace(/'/g, "''")}'`)
      .join(', ');
    const canonical = `CREATE TYPE "${e.schema}"."${e.name}" AS ENUM(${valuesSqlList});`;

    const findRe = new RegExp(
      `CREATE\\s+TYPE\\s+(?:"${escapeRegExp(e.schema)}"\\.)?"${escapeRegExp(
        e.name,
      )}"\\s+AS\\s+ENUM\\s*\\([^)]*\\)\\s*;(?:--> statement-breakpoint)?`,
      'gi',
    );

    const matched = findRe.test(body);
    findRe.lastIndex = 0;

    const snapshotKey = `${e.schema}.${e.name}`;
    const snapEnum = snapshot.enums?.[snapshotKey];

    const introspectValues = snapEnum?.values ?? null;
    const valuesIdentical =
      introspectValues !== null &&
      introspectValues.length === e.values.length &&
      introspectValues.every((v, i) => v === e.values[i]);

    if (matched && !valuesIdentical) {
      body = body.replace(findRe, `${canonical}--> statement-breakpoint`);
      result.replaced++;
    } else if (!matched) {
      // Enum exists on target but missing entirely from introspect SQL.
      toAppend.push(canonical);
      result.appended++;
    }

    // Always keep snapshot in sync with target's true values.
    if (snapEnum && !valuesIdentical) {
      snapEnum.values = [...e.values];
    } else if (!snapEnum && !matched) {
      if (!snapshot.enums) snapshot.enums = {};
      snapshot.enums[snapshotKey] = {
        name: e.name,
        schema: e.schema,
        values: [...e.values],
      };
    }
  }

  if (toAppend.length > 0) {
    if (!body.endsWith('\n')) body += '\n';
    body += `${toAppend.join('\n--> statement-breakpoint\n')}\n`;
  }

  if (result.replaced > 0 || result.appended > 0) {
    writeFileSync(baselineFile, body);
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  }

  return result;
}

// ---- pg_extension + pg_attrdef supplement ----

interface ExtAndDefaultsResult {
  extensionsAdded: number;
  defaultsFixed: number;
}

async function supplementExtensionsAndDefaults(
  previewDir: string,
  baselineFile: string,
  config: DrizzleConfig,
): Promise<ExtAndDefaultsResult> {
  const snapshotPath = path.join(previewDir, 'meta', '0000_snapshot.json');
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as SnapshotJson & {
    tables?: Record<string, SnapshotTable & {
      columns?: Record<string, SnapshotColumn & { default?: unknown }>;
    }>;
  };

  let body = readFileSync(baselineFile, 'utf8');
  const result: ExtAndDefaultsResult = { extensionsAdded: 0, defaultsFixed: 0 };

  // Extensions: drizzle-kit never emits CREATE EXTENSION. Prepend one
  // `CREATE EXTENSION IF NOT EXISTS "<name>" WITH SCHEMA "<schema>";` per
  // installed non-builtin extension. (`reorderForFkSafety` will then move
  // them into the `extension` bucket, before CREATE TYPE / CREATE TABLE.)
  const extensions = await listPgExtensions(config.dbCredentials);
  if (extensions.length > 0) {
    const extStmts = extensions.map(
      (e) => `CREATE EXTENSION IF NOT EXISTS "${e.name}" WITH SCHEMA "${e.schema}";`,
    );
    body = `${extStmts.join('\n--> statement-breakpoint\n')}\n--> statement-breakpoint\n${body}`;
    result.extensionsAdded = extensions.length;
  }

  // Column defaults: compare each target default vs snapshot. If different,
  // append an ALTER TABLE SET DEFAULT so it overrides any wrong default
  // baked into CREATE TABLE. Also fix the snapshot so downstream diffs see
  // the truth. Normalize by trimming whitespace + lowercasing — enough to
  // dedupe trivial formatting differences without hiding real semantic
  // changes (cast suffixes, expression rewrites).
  const targetDefaults = await listPgColumnDefaults(config.dbCredentials);
  const altered: string[] = [];
  for (const d of targetDefaults) {
    const tableKey = `${d.schema}.${d.table}`;
    const tbl = snapshot.tables?.[tableKey];
    if (!tbl) continue;
    const col = tbl.columns?.[d.column] as
      | (SnapshotColumn & { default?: unknown })
      | undefined;
    if (!col) continue;
    const snapDefault = col.default;
    const same =
      typeof snapDefault === 'string' &&
      snapDefault.trim().toLowerCase() === d.defaultExpr.trim().toLowerCase();
    if (same) continue;
    altered.push(
      `ALTER TABLE "${d.schema}"."${d.table}" ALTER COLUMN "${d.column}" SET DEFAULT ${d.defaultExpr};`,
    );
    col.default = d.defaultExpr;
    result.defaultsFixed++;
  }
  if (altered.length > 0) {
    if (!body.endsWith('\n')) body += '\n';
    body += `${altered.join('\n--> statement-breakpoint\n')}\n`;
  }

  if (result.extensionsAdded > 0 || result.defaultsFixed > 0) {
    writeFileSync(baselineFile, body);
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  }
  return result;
}

// ---- temp-DB URL resolution (manual vs admin auto-provision) ----

interface ResolvedTempDbs {
  schemaDbUrl: string;
  verifyDbUrl: string;
  // When admin-mode auto-provisioned the two DBs, the bare names go here so the
  // final reminder can print exact `DROP DATABASE "..."` commands. In manual
  // mode both are null.
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
    const schemaName = `drizzleman_schema_${tsName}`;
    // NOTE: literal naming per user spec — verify segment has no underscore
    // between `db` and the timestamp. Do not "normalize" to symmetric form.
    const verifyName = `drizzleman_verify_db${tsName}`;
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
  ok: boolean;
  sql: string;
  error: string | null;
}

// migra is built on SQLAlchemy, whose URL dialect registry only recognises
// `postgresql://` — `postgres://` raises "NoSuchModuleError: Can't load
// plugin: sqlalchemy.dialects:postgres". The pg / pg-driver layers we use
// elsewhere accept both, so URLs flow through drizzleman in either form
// freely. Normalize only at the migra boundary.
function normalizeUrlForMigra(url: string): string {
  if (/^postgres:\/\//i.test(url)) return url.replace(/^postgres:\/\//i, 'postgresql://');
  return url;
}

function runMigra(
  fromUrl: string,
  toUrl: string,
  excludeSchemas: string[],
): Promise<MigraResult> {
  return new Promise((resolve) => {
    const args = ['--unsafe'];
    // migra's argparse uses underscore: --exclude_schema (not --exclude-schema).
    for (const s of excludeSchemas) args.push(`--exclude_schema=${s}`);
    args.push(normalizeUrlForMigra(fromUrl), normalizeUrlForMigra(toUrl));

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
      // Trust stdout as source of truth (per plan: "以 stdout 是否为空为准").
      // migra exit codes with --unsafe: 0 = equal, 2 = differ (diff printed),
      // 3 = unsafe changes refused (shouldn't happen with --unsafe set), 1 = error.
      // We accept 0/2/3 as "ran successfully, stdout tells you the answer";
      // any other code with stderr content is treated as an error.
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

// ---- verify staging ----

// Build a self-contained drizzle-kit migrations dir holding ONLY the 0000 sql
// (+ snapshot + a journal with a single entry). Used to apply 0000 to verify
// DB in isolation, so we can compare verifyDB ↔ targetDB after.
function stageVerifyDir_v1(
  previewDir: string,
  verifyDir: string,
  baselineSqlName: string,
): void {
  mkdirSync(path.join(verifyDir, 'meta'), { recursive: true });
  copyFileSync(
    path.join(previewDir, baselineSqlName),
    path.join(verifyDir, baselineSqlName),
  );
  copyFileSync(
    path.join(previewDir, 'meta', '0000_snapshot.json'),
    path.join(verifyDir, 'meta', '0000_snapshot.json'),
  );
  const journalRaw = JSON.parse(
    readFileSync(path.join(previewDir, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ idx: number }> } & Record<string, unknown>;
  const v1Journal = {
    ...journalRaw,
    entries: journalRaw.entries.filter((e) => e.idx === 0),
  };
  writeFileSync(
    path.join(verifyDir, 'meta', '_journal.json'),
    JSON.stringify(v1Journal, null, 2),
  );
}

// Extend the V1 dir with 0001 sql + 0001 snapshot + the full journal (both
// entries). drizzle-kit migrate will skip 0000 (hash already in
// __drizzle_migrations on verify DB) and apply only 0001.
function stageVerifyDir_v2(previewDir: string, verifyDir: string): void {
  copyFileSync(
    path.join(previewDir, '0001_delta.sql'),
    path.join(verifyDir, '0001_delta.sql'),
  );
  copyFileSync(
    path.join(previewDir, 'meta', '0001_snapshot.json'),
    path.join(verifyDir, 'meta', '0001_snapshot.json'),
  );
  // Restore the full journal (V1 trimmed it to just entry 0).
  copyFileSync(
    path.join(previewDir, 'meta', '_journal.json'),
    path.join(verifyDir, 'meta', '_journal.json'),
  );
}

async function migrateAgainst(
  verifyDir: string,
  dbUrl: string,
  dialect: DrizzleConfig['dialect'],
): Promise<number> {
  const tmpConfig = path.join(verifyDir, 'drizzle.config.json');
  writeFileSync(
    tmpConfig,
    JSON.stringify(
      { dialect, out: verifyDir, dbCredentials: { url: dbUrl } },
      null,
      2,
    ),
  );
  return passthrough(['migrate', `--config=${tmpConfig}`]);
}

interface VerifyOutcome {
  v1Pass: boolean;
  v2Pass: boolean | 'skipped';
  v3Pass: boolean;
  aborted: boolean;
  notes: string[];
}

async function runVerify(args: {
  config: DrizzleConfig;
  previewDir: string;
  tmpgenDir: string;
  baselineSqlName: string;
  deltaWritten: boolean;
  verifyDir: string;
  verifyIntroDir: string;
  verifyDbUrl: string;
  schemaDbUrl: string;
  migrationsSchema: string;
}): Promise<VerifyOutcome> {
  const {
    config,
    previewDir,
    tmpgenDir,
    baselineSqlName,
    deltaWritten,
    verifyDir,
    verifyIntroDir,
    verifyDbUrl,
    schemaDbUrl,
    migrationsSchema,
  } = args;
  const notes: string[] = [];
  const outcome: VerifyOutcome = {
    v1Pass: false,
    v2Pass: deltaWritten ? false : 'skipped',
    v3Pass: false,
    aborted: false,
    notes,
  };
  const targetUrl = credsToUrl(config.dbCredentials);
  // Both verify and target/schemaDB have a drizzle-kit migrations table after
  // we run drizzle-kit migrate against them. Excluding the migrations schema
  // suppresses migra noise from that bookkeeping table.
  const excludes = [migrationsSchema];

  // ---- V1: apply 0000 → verifyDB; compare verifyDB ↔ targetDB ----
  console.log(pc.bold('  V1 (命题 ①): apply 0000 to verify DB → migra(verify, target)'));
  stageVerifyDir_v1(previewDir, verifyDir, baselineSqlName);
  const v1Migrate = await migrateAgainst(verifyDir, verifyDbUrl, config.dialect);
  if (v1Migrate !== 0) {
    console.log(
      pc.red(
        `    ✗ apply 0000 to verify DB failed (exit ${v1Migrate}); 0000 SQL is not executable on a fresh DB. Aborting verify.`,
      ),
    );
    outcome.aborted = true;
    return outcome;
  }
  const v1Migra = await runMigra(verifyDbUrl, targetUrl, excludes);
  if (v1Migra.error !== null) {
    console.log(pc.red(`    ✗ migra failed: ${v1Migra.error}`));
    notes.push(`V1 migra: ${v1Migra.error}`);
    outcome.aborted = true;
    return outcome;
  }
  if (v1Migra.ok) {
    console.log(pc.green('    ✓ verify DB ≡ target DB (0000 reconstructs target)'));
    outcome.v1Pass = true;
  } else {
    console.log(pc.red('    ✗ verify DB ≠ target DB; migra diff:'));
    process.stderr.write(`\n----- V1 migra diff (verify → target) -----\n${v1Migra.sql}\n-------------------------------------------\n\n`);
    notes.push('V1 failed: 0000 does not match target DB structure.');
  }

  // ---- V2: extend verifyDir with 0001 → apply → compare verifyDB ↔ schemaDB ----
  if (deltaWritten) {
    console.log(pc.bold('  V2 (命题 ②): apply 0001 to verify DB → migra(verify, schema)'));
    stageVerifyDir_v2(previewDir, verifyDir);
    const v2Migrate = await migrateAgainst(verifyDir, verifyDbUrl, config.dialect);
    if (v2Migrate !== 0) {
      console.log(
        pc.red(
          `    ✗ apply 0001 to verify DB failed (exit ${v2Migrate}); 0001 SQL is not executable on top of 0000. Aborting V2/V3.`,
        ),
      );
      outcome.aborted = true;
      return outcome;
    }
    const v2Migra = await runMigra(verifyDbUrl, schemaDbUrl, excludes);
    if (v2Migra.error !== null) {
      console.log(pc.red(`    ✗ migra failed: ${v2Migra.error}`));
      notes.push(`V2 migra: ${v2Migra.error}`);
      outcome.aborted = true;
      return outcome;
    }
    if (v2Migra.ok) {
      console.log(pc.green('    ✓ verify DB ≡ schema DB (0000+0001 reconstructs local schema)'));
      outcome.v2Pass = true;
    } else {
      console.log(pc.red('    ✗ verify DB ≠ schema DB; migra diff:'));
      process.stderr.write(`\n----- V2 migra diff (verify → schema) -----\n${v2Migra.sql}\n-------------------------------------------\n\n`);
      notes.push('V2 failed: 0000+0001 does not match local Drizzle schema.');
    }
  } else {
    console.log(pc.dim('  V2 (命题 ②): skipped — no 0001_delta.sql (target already matches schema)'));
  }

  // ---- V3: introspect verifyDB and diffSnapshots vs tmpgen (drizzle layer) ----
  console.log(pc.bold('  V3 (命题 ③): introspect verify DB → diffSnapshots vs tmpgen'));
  mkdirSync(verifyIntroDir, { recursive: true });
  const introCode = await passthrough([
    'introspect',
    `--dialect=${config.dialect}`,
    `--url=${verifyDbUrl}`,
    `--out=${verifyIntroDir}`,
  ]);
  if (introCode !== 0) {
    console.log(pc.red(`    ✗ introspect of verify DB exited ${introCode}; V3 inconclusive.`));
    notes.push('V3 inconclusive: introspect failed.');
    return outcome;
  }
  try {
    const verifySnap = readSnapshot(verifyIntroDir);
    const tmpgenSnap = JSON.parse(
      readFileSync(path.join(tmpgenDir, 'meta', '0000_snapshot.json'), 'utf8'),
    ) as SnapshotJson;
    const diff = diffSnapshots(verifySnap, tmpgenSnap);
    const empty =
      diff.onlyInTarget.tables.length === 0 &&
      diff.onlyInTarget.columns.length === 0 &&
      diff.onlyInTarget.indexes.length === 0 &&
      diff.onlyInTarget.foreignKeys.length === 0 &&
      diff.onlyInTarget.enums.length === 0 &&
      diff.onlyInTarget.checks.length === 0 &&
      diff.onlyInSchemaDb.tables.length === 0 &&
      diff.onlyInSchemaDb.columns.length === 0 &&
      diff.onlyInSchemaDb.indexes.length === 0 &&
      diff.onlyInSchemaDb.foreignKeys.length === 0 &&
      diff.onlyInSchemaDb.enums.length === 0 &&
      diff.onlyInSchemaDb.checks.length === 0 &&
      diff.changedChecks.length === 0 &&
      diff.enumValueChanges.length === 0;
    if (empty) {
      console.log(pc.green('    ✓ snapshot diff is empty (drizzle semantic layer agrees with migra)'));
      outcome.v3Pass = true;
    } else {
      console.log(pc.red('    ✗ snapshot diff non-empty:'));
      console.log(`      onlyInVerify : ${fmtDiffSet(diff.onlyInTarget)}`);
      console.log(`      onlyInTmpgen : ${fmtDiffSet(diff.onlyInSchemaDb)}`);
      if (diff.changedChecks.length > 0)
        console.log(`      changedChecks: ${diff.changedChecks.length}`);
      if (diff.enumValueChanges.length > 0)
        console.log(`      enum changes : ${diff.enumValueChanges.length}`);
      notes.push('V3 failed: diffSnapshots(verify, tmpgen) non-empty.');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`    ✗ V3 read/diff failed: ${msg}`));
    notes.push(`V3 error: ${msg}`);
  }

  return outcome;
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
        `[drizzleman] ✗ drizzle config has no 'schema' field; cannot push local schema to schema DB. Add e.g. schema: './src/schema/index.ts' and retry.`,
      ),
    );
    return 1;
  }

  const ts = Date.now();

  // Resolve schema DB / verify DB URLs (manual two-URL mode OR admin-mode auto-provision).
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
  // For migra exclusion. Defaults to "drizzle" on postgres via migrationsTableOf.
  const migrationsSchema = table.schema ?? 'drizzle';

  // All artifacts (fs dirs, backup tables, tmpgen dir, auto-provisioned DB
  // names) share the same human-readable timestamp YYYYMMDD_HHmmss derived
  // from `ts = Date.now()`, so the matching pairs are obvious on disk.
  const tsLabel = timestampForDbName(ts);
  const previewName = `${PREVIEW_PREFIX}${tsLabel}`;
  const previewDir = path.join(outDir, previewName);
  const tmpDir = path.join(outDir, `${SCHEMADB_INTRO_PREFIX}${tsLabel}`);
  const verifyMigDir = path.join(outDir, `${VERIFY_MIG_PREFIX}${tsLabel}`);
  const verifyIntroDir = path.join(outDir, `${VERIFYDB_INTRO_PREFIX}${tsLabel}`);
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
  if (existsSync(tmpDir)) {
    console.log(pc.red(`[drizzleman] ✗ schema-db introspect dir already exists: ${rel(tmpDir)}; remove it and retry.`));
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
    (n) =>
      !n.startsWith(PREVIEW_PREFIX) &&
      !n.startsWith(BAK_PREFIX) &&
      !n.startsWith(REF_PREFIX) &&
      !n.startsWith(SCHEMADB_INTRO_PREFIX) &&
      !n.startsWith(VERIFY_MIG_PREFIX) &&
      !n.startsWith(VERIFYDB_INTRO_PREFIX),
  );

  console.log(pc.bold('[drizzleman] Current state:'));
  console.log(`  existing entries in ${rel(outDir)}/ : ${pc.cyan(String(existingMigrationFiles.length))}`);
  if (appliedError) {
    console.log(`  DB rows in ${tableLabel}            : ${pc.yellow('(read failed)')} ${pc.dim(appliedError)}`);
  } else {
    console.log(`  DB rows in ${tableLabel}            : ${pc.cyan(String(applied.length))}`);
  }

  // ---- Step B: assert schema DB is empty ----
  // Runs BEFORE Step A so --check-only can exit without touching target
  // (Step A introspects target into previewDir; Step B/Bv are pure read checks
  // against the two temp DBs).
  console.log(pc.bold(`\n[drizzleman] Step B: assert schema DB is empty`));
  try {
    await assertSchemaDbEmpty(config.dialect, { url: schemaDbUrl });
    console.log(pc.green('  ✓ schema DB has no user-schema tables'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`  ✗ ${msg}`));
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  // Same check for verify DB — even an admin-mode freshly-created DB should be empty,
  // but in manual mode the user might point us at a DB with leftover state.
  try {
    await assertSchemaDbEmpty(config.dialect, { url: verifyDbUrl });
    console.log(pc.green('  ✓ verify DB has no user-schema tables'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`  ✗ verify DB: ${msg}`));
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }

  // ---- Step Bv: probe engines & versions of target / schema / verify DBs ----
  // Same engine + same major version is mandatory: a verify pass on PG 16 does
  // not vouch for PG 13 target behaviour, and a stock-postgres verify pass
  // does not vouch for CockroachDB / Yugabyte / etc. (these claim postgres
  // wire-compat but diverge on DDL semantics).
  console.log(pc.bold('\n[drizzleman] Step Bv: probe DB engines & versions'));
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
    const matrix = probeOk
      .map((p, i) => `${probeLabels[i]}=${p.engine}`)
      .join(' / ');
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
    const matrix = probeOk
      .map((p, i) => `${probeLabels[i]}=${p.majorVersion}`)
      .join(' / ');
    if (flags.allowVersionMismatch) {
      console.log(
        pc.yellow(
          `  ⚠ major version mismatch: ${matrix}. --allow-version-mismatch given → continuing, but verify may not represent target behaviour.`,
        ),
      );
    } else {
      console.log(
        pc.red(
          `  ✗ major version mismatch: ${matrix}. Pass --allow-version-mismatch to override.`,
        ),
      );
      printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
      return 1;
    }
  } else {
    console.log(pc.green('  ✓ engines and major versions agree'));
  }

  // ---- --check-only exit: stop here, before Step A touches anything ----
  // Preflight passed (URLs resolved, target readable, both temp DBs empty,
  // engines & major versions agree). --check-only's contract is "validate
  // setup, don't generate or apply" — so we exit before Step A (target
  // introspect) which would create the preview dir.
  if (flags.checkOnly) {
    console.log(
      pc.green('\n[drizzleman] ✓ --check-only: preflight checks all passed.'),
    );
    console.log(pc.dim('  No preview generated, no SQL written, no DB mutated.'));
    if (provisioned.schema || provisioned.verify) {
      console.log(
        pc.dim(
          '  Admin-mode auto-created two temp DBs; they remain (not auto-dropped). See reminder below.',
        ),
      );
    }
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 0;
  }

  // ---- Step A: introspect target DB ----
  console.log(pc.bold(`\n[drizzleman] Step A: introspect target DB → ${rel(previewDir)}/`));
  mkdirSync(previewDir, { recursive: true });
  const introTargetArgs = [
    'introspect',
    `--dialect=${config.dialect}`,
    ...buildCredsArgs(config.dbCredentials),
    `--out=${previewDir}`,
  ];
  let code = await passthrough(introTargetArgs);
  if (code !== 0) {
    console.log(pc.red(`[drizzleman] ✗ target introspect exited ${code}; cleaning up.`));
    cleanupDir(previewDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return code;
  }

  const introJournal = readPreviewJournal(previewDir);
  if (introJournal.length !== 1 || introJournal[0]!.idx !== 0) {
    console.log(
      pc.red(
        `[drizzleman] ✗ expected exactly one idx=0 entry in preview journal after introspect; got ${introJournal.length}.`,
      ),
    );
    cleanupDir(previewDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }

  let renameInfo: { oldTag: string; newTag: string };
  try {
    renameInfo = renameRebaseTag(previewDir, name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`[drizzleman] ✗ failed to rename baseline tag: ${msg}`));
    cleanupDir(previewDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  if (renameInfo.oldTag !== renameInfo.newTag) {
    console.log(pc.dim(`  renamed ${renameInfo.oldTag} → ${renameInfo.newTag}`));
  }
  const baselineSqlName = `${renameInfo.newTag}.sql`;
  const baselineFile = path.join(previewDir, baselineSqlName);
  // Two rewrites before computing the hash:
  //   (a) Strip introspect's `/* ... */` wrapper so 0000 is real, executable DDL.
  //   (b) Reorder so CREATE INDEX precedes ALTER TABLE ADD FK — drizzle-kit
  //       introspect emits FK ALTERs before the unique-index CREATEs that some
  //       FKs depend on. Without reordering, a fresh-DB `drizzleman migrate`
  //       would fail with SQLSTATE 42830 ("no unique constraint matching ...").
  // Hash must be computed AFTER both rewrites — drizzle-kit migrate stores
  // sha256 of file content; mismatch would mark 0000 perpetually "pending".
  {
    const raw = readFileSync(baselineFile, 'utf8');
    const stripped = uncommentIntrospectSql(raw);
    // Strip drizzle-kit's unreliable opclass annotations on index columns —
    // see `stripIndexOpclasses` for the introspect bug it works around.
    const cleaned = stripIndexOpclasses(stripped);
    if (cleaned !== raw) {
      writeFileSync(baselineFile, cleaned);
    }
    // Repair enum CREATE TYPE statements against pg_enum (drizzle-kit
    // sometimes drops enum values, leaving CHECK constraints / column
    // defaults that reference unknown labels un-applyable on a fresh DB).
    const enumSupp = await supplementEnumValues(previewDir, baselineFile, config);
    if (enumSupp.replaced > 0 || enumSupp.appended > 0) {
      console.log(
        pc.dim(
          `  pg_enum fixup: replaced=${enumSupp.replaced} appended=${enumSupp.appended}`,
        ),
      );
    }
    // CREATE EXTENSION supplements (drizzle-kit never emits them) +
    // ALTER COLUMN SET DEFAULT fixups (drizzle-kit mangles some defaults
    // like `'{}'::text[]` into `'{""}'`). Both placed via dedicated buckets
    // in reorderForFkSafety: extensions before types, alter-default after
    // tables.
    const extDef = await supplementExtensionsAndDefaults(previewDir, baselineFile, config);
    if (extDef.extensionsAdded > 0 || extDef.defaultsFixed > 0) {
      console.log(
        pc.dim(
          `  pg_extension/attrdef fixup: +${extDef.extensionsAdded} extension(s), ` +
            `${extDef.defaultsFixed} column default(s) corrected`,
        ),
      );
    }
    // Repair / supplement indexes via pg_indexes + pg_get_indexdef (drizzle-kit
    // 0.31.x mis-serializes DESC / NULLS modifiers, mangles opclasses, and
    // sometimes drops standalone unique indexes entirely). We do this BEFORE
    // FK-safe reorder so inserted CREATE INDEX statements get placed before
    // any ALTER ADD FK that depends on them.
    const supp = await supplementMissingIndexes(previewDir, baselineFile, config);
    if (supp.replaced > 0 || supp.appended > 0) {
      console.log(
        pc.dim(
          `  pg_indexes fixup: replaced=${supp.replaced} appended=${supp.appended} ` +
            `(snapshot-supplemented=${supp.appendedToSnapshot}, sql-only=${supp.sqlOnly})`,
        ),
      );
    }
    // Now reorder FK-safe (CREATE INDEX before ALTER ADD FK). Reading the
    // file again because both the cleanup and supplement may have written to it.
    const current = readFileSync(baselineFile, 'utf8');
    const reordered = reorderForFkSafety(current);
    if (reordered !== current) writeFileSync(baselineFile, reordered);

    const finalContent = readFileSync(baselineFile, 'utf8');
    if (finalContent !== raw) {
      const notes: string[] = [];
      if (stripped !== raw) notes.push('unwrapped /* ... */');
      if (cleaned !== stripped) notes.push('stripped index opclass annotations');
      if (supp.replaced > 0) notes.push(`replaced ${supp.replaced} index def(s) via pg_get_indexdef`);
      if (supp.appended > 0) notes.push(`+${supp.appended} missing index(es)`);
      if (reordered !== current) notes.push('reordered CREATE INDEX before ALTER ADD FK');
      if (notes.length > 0) console.log(pc.dim(`  rewrote 0000 (${notes.join(', ')})`));
    }
  }
  const rebaseHash = hashFile(baselineFile);

  // ---- Step C: materialize local schema to schema DB via generate + migrate ----
  // We deliberately avoid `drizzle-kit push` — in 0.31.5 it silently drops indexes
  // declared in pgTable's second-arg callback (and some FKs), yielding a fake schema
  // DB snapshot that under-reports local schema. `generate` produces canonical SQL
  // covering everything; `migrate` then applies it via drizzle-kit's own runner.
  console.log(pc.bold(`\n[drizzleman] Step C: drizzle-kit generate → migrate (schema DB)`));
  const tmpgenDir = path.join('/tmp', `drizzleman-rebase-tmpgen-${tsLabel}`);
  if (existsSync(tmpgenDir)) {
    console.log(pc.red(`[drizzleman] ✗ tmpgen dir already exists: ${tmpgenDir}; remove it and retry.`));
    cleanupDir(previewDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  mkdirSync(tmpgenDir, { recursive: true });
  console.log(pc.dim(`  tmpgen: ${tmpgenDir}`));

  const genTmpArgs = [
    'generate',
    `--dialect=${config.dialect}`,
    ...buildSchemaArgs(config.schema),
    `--out=${tmpgenDir}`,
    '--name=schema',
  ];
  code = await passthrough(genTmpArgs);
  if (code !== 0) {
    console.log(pc.red(`[drizzleman] ✗ generate (to tmpgen) exited ${code}.`));
    cleanupDir(previewDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return code;
  }

  // Reorder the generated SQL: drizzle-kit emits FK constraints BEFORE unique
  // indexes that the FKs depend on (any FK referencing a uniqueIndex-backed
  // unique constraint fails with "no unique constraint matching given keys" /
  // pg error 42830). Bucket statements into:
  //   CREATE TYPE  →  CREATE TABLE  →  CREATE [UNIQUE] INDEX  →  ALTER … FK  →  other
  const generatedSqlPath = path.join(tmpgenDir, '0000_schema.sql');
  if (existsSync(generatedSqlPath)) {
    const original = readFileSync(generatedSqlPath, 'utf8');
    const reordered = reorderForFkSafety(original);
    if (reordered !== original) {
      writeFileSync(generatedSqlPath, reordered);
      console.log(pc.dim('  reordered generated SQL (CREATE INDEX before ALTER ADD FK)'));
    }
  }

  // drizzle-kit migrate only accepts --config (no other flags), so write a tiny
  // JSON config pointing at tmpgen + schema DB url, then invoke.
  const tmpConfigPath = path.join(tmpgenDir, 'drizzle.config.json');
  writeFileSync(
    tmpConfigPath,
    JSON.stringify(
      {
        dialect: config.dialect,
        out: tmpgenDir,
        dbCredentials: { url: schemaDbUrl },
      },
      null,
      2,
    ),
  );

  const migrateArgs = ['migrate', `--config=${tmpConfigPath}`];
  code = await passthrough(migrateArgs);
  if (code !== 0) {
    console.log(
      pc.red(
        `[drizzleman] ✗ migrate (to schema DB) exited ${code}; schema DB may be partially populated. Drop it and retry. tmpgen kept at ${tmpgenDir} for inspection.`,
      ),
    );
    cleanupDir(previewDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return code;
  }

  // ---- Step D: introspect schema DB ----
  console.log(pc.bold(`\n[drizzleman] Step D: introspect schema DB → ${rel(tmpDir)}/`));
  mkdirSync(tmpDir, { recursive: true });
  const introSchemaDbArgs = [
    'introspect',
    `--dialect=${config.dialect}`,
    `--url=${schemaDbUrl}`,
    `--out=${tmpDir}`,
  ];
  code = await passthrough(introSchemaDbArgs);
  if (code !== 0) {
    console.log(pc.red(`[drizzleman] ✗ schema DB introspect exited ${code}; cleaning up.`));
    cleanupDir(tmpDir);
    cleanupDir(previewDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return code;
  }

  // ---- Step E: snapshot diff ----
  console.log(pc.bold('\n[drizzleman] Step E: structural snapshot diff'));
  let diff: SnapshotDiff;
  try {
    const targetSnap = readSnapshot(previewDir);
    const schemaDbSnap = readSnapshot(tmpDir);
    diff = diffSnapshots(targetSnap, schemaDbSnap);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`  ✗ failed to read snapshots: ${msg}`));
    cleanupDir(tmpDir);
    cleanupDir(previewDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  console.log(`  onlyInSchemaDb (→ 0001_delta.sql): ${pc.cyan(fmtDiffSet(diff.onlyInSchemaDb))}`);
  console.log(`  onlyInTarget   (→ schema.sql)   : ${pc.cyan(fmtDiffSet(diff.onlyInTarget))}`);
  if (diff.changedChecks.length > 0) {
    console.log(`  changedChecks  (→ DROP+ADD in 0001): ${pc.cyan(String(diff.changedChecks.length))}`);
  }
  if (diff.enumValueChanges.length > 0) {
    const added = diff.enumValueChanges.reduce((s, e) => s + e.added.length, 0);
    const removed = diff.enumValueChanges.reduce((s, e) => s + e.removed.length, 0);
    console.log(
      `  enum value changes : ${pc.cyan(`+${added} -${removed}`)}  ${pc.dim('(+ in 0001 via ALTER TYPE ADD VALUE; - cannot be dropped by postgres)')}`,
    );
  }

  // ---- Step F: chunk both 0000 SQLs ----
  const targetSqlPath = baselineFile;
  const schemaDbJournal = readPreviewJournal(tmpDir);
  if (schemaDbJournal.length !== 1 || schemaDbJournal[0]!.idx !== 0) {
    console.log(pc.red(`  ✗ unexpected journal in schema-db introspect dir (entries=${schemaDbJournal.length})`));
    cleanupDir(tmpDir);
    cleanupDir(previewDir);
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  const schemaDbSqlPath = path.join(tmpDir, `${schemaDbJournal[0]!.tag}.sql`);
  // Apply the same opclass-strip rewrite to the schema-DB introspected SQL
  // before chunking — otherwise statements lifted out of these chunks (e.g.,
  // CREATE INDEX going into 0001_delta.sql) carry the same buggy opclass
  // annotations and fail at apply time on non-text columns.
  {
    const raw = readFileSync(schemaDbSqlPath, 'utf8');
    const cleaned = stripIndexOpclasses(raw);
    if (cleaned !== raw) {
      writeFileSync(schemaDbSqlPath, cleaned);
      console.log(pc.dim('  rewrote schema-DB introspect SQL (stripped index opclass annotations)'));
    }
  }
  const targetChunks = chunkSql(readFileSync(targetSqlPath, 'utf8'));
  const schemaDbChunks = chunkSql(readFileSync(schemaDbSqlPath, 'utf8'));

  // ---- Step G: write 0001_delta.sql + schema.sql ----
  // 0001 only exists when there are real entities to migrate; empty diff means
  // no idx=1 entry is appended (no orphan file in migrations/).
  // buildDeltaSql / buildSchemaSql sort chunks by kind (enum → table → index → fk)
  // so any FK that depends on a uniqueIndex-only-unique column lands AFTER its index.
  const deltaSql = buildDeltaSql(schemaDbChunks, diff);
  const deltaFile = path.join(previewDir, '0001_delta.sql');
  let deltaWritten = false;
  if (deltaSql.length > 0) {
    writeFileSync(deltaFile, `${deltaSql}\n`);
    deltaWritten = true;

    // Register 0001 in _journal.json so `drizzleman migrate` actually sees it.
    const journalPath = path.join(previewDir, 'meta', '_journal.json');
    const journalRaw = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      version: string;
      dialect: string;
      entries: Array<{
        idx: number;
        version?: string;
        when: number;
        tag: string;
        breakpoints?: boolean;
      }>;
    };
    const baselineEntry = journalRaw.entries.find((e) => e.idx === 0);
    journalRaw.entries.push({
      idx: 1,
      version: baselineEntry?.version ?? journalRaw.version,
      when: Date.now(),
      tag: '0001_delta',
      breakpoints: true,
    });
    writeFileSync(journalPath, JSON.stringify(journalRaw, null, 2));

    // Write meta/0001_snapshot.json from tmpgen (drizzle-kit generate's own
    // serialization of local schema). Using introspect's snapshot (tmpDir)
    // would be structurally equivalent but textually different, which would
    // make the NEXT `drizzle-kit generate` emit a spurious renaming-style diff.
    const targetSnapshotPath = path.join(previewDir, 'meta', '0000_snapshot.json');
    const tmpgenSnapshotPath = path.join(tmpgenDir, 'meta', '0000_snapshot.json');
    const targetSnap = JSON.parse(readFileSync(targetSnapshotPath, 'utf8')) as {
      id?: string;
    };
    const tmpgenSnap = JSON.parse(readFileSync(tmpgenSnapshotPath, 'utf8')) as Record<
      string,
      unknown
    >;
    tmpgenSnap.id = randomUUID();
    tmpgenSnap.prevId = targetSnap.id ?? '';
    writeFileSync(
      path.join(previewDir, 'meta', '0001_snapshot.json'),
      JSON.stringify(tmpgenSnap, null, 2),
    );
  }
  const schemaSql = buildSchemaSql(targetChunks, diff);
  const schemaFile = path.join(previewDir, 'schema.sql');
  writeFileSync(schemaFile, schemaSql);

  // Zero-diff case: replace meta/0000_snapshot.json with tmpgen's snapshot
  // (preserving 0000's id/prevId so the chain stays anchored at the same point).
  // Otherwise a future `drizzle-kit generate` would diff local schema against
  // introspect's text-different snapshot and emit a spurious migration even
  // though nothing structurally changed.
  if (!deltaWritten) {
    const baselineSnapshotPath = path.join(previewDir, 'meta', '0000_snapshot.json');
    const tmpgenSnapshotPath = path.join(tmpgenDir, 'meta', '0000_snapshot.json');
    if (existsSync(tmpgenSnapshotPath)) {
      const oldSnap = JSON.parse(readFileSync(baselineSnapshotPath, 'utf8')) as {
        id?: string;
        prevId?: string;
      };
      const tmpgenSnap = JSON.parse(readFileSync(tmpgenSnapshotPath, 'utf8')) as Record<
        string,
        unknown
      >;
      tmpgenSnap.id = oldSnap.id ?? randomUUID();
      tmpgenSnap.prevId = oldSnap.prevId ?? '';
      writeFileSync(baselineSnapshotPath, JSON.stringify(tmpgenSnap, null, 2));
    }
  }

  // ---- Step V: three-proposition verify gate ----
  console.log(pc.bold('\n[drizzleman] Step V: verify (三命题闸口)'));
  const verifyOutcome = await runVerify({
    config,
    previewDir,
    tmpgenDir,
    baselineSqlName,
    deltaWritten,
    verifyDir: verifyMigDir,
    verifyIntroDir,
    verifyDbUrl,
    schemaDbUrl,
    migrationsSchema,
  });
  const verifyOk =
    verifyOutcome.v1Pass &&
    (verifyOutcome.v2Pass === true || verifyOutcome.v2Pass === 'skipped') &&
    verifyOutcome.v3Pass &&
    !verifyOutcome.aborted;
  if (!verifyOk) {
    console.log(pc.red('\n[drizzleman] ✗ verify failed; refusing to apply.'));
    for (const n of verifyOutcome.notes) console.log(pc.red(`  · ${n}`));
    console.log(pc.dim(`  preview retained at ${rel(previewDir)}/ for inspection.`));
    console.log(pc.dim(`  verify staging:    ${rel(verifyMigDir)}/`));
    if (existsSync(verifyIntroDir))
      console.log(pc.dim(`  verify introspect: ${rel(verifyIntroDir)}/`));
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  console.log(pc.green('  ✓ all three propositions pass'));

  // ---- Step H: cleanup tmpDir, render preview ----
  cleanupDir(tmpDir);

  console.log(pc.bold('\n[drizzleman] Preview artifacts:'));
  const previewRows: Array<[string, string]> = [
    [`  0000 ${pc.dim('(target DB structure, will be marked applied)')}`, baselineFile],
  ];
  if (deltaWritten) {
    previewRows.push([
      `  0001 ${pc.dim('(delta from snapshot diff, PENDING — `drizzleman migrate` will apply)')}`,
      deltaFile,
    ]);
  } else {
    console.log(
      pc.dim('  0001: ✓ no delta — local schema matches target; no migration file written.'),
    );
  }
  previewRows.push([
    `  schema.sql ${pc.dim('(target-only entities; reference only — paste into your local schema)')}`,
    schemaFile,
  ]);
  for (const [label, file] of previewRows) {
    const size = statSync(file).size;
    const lines = countLines(file);
    console.log(`${label}: ${pc.cyan(rel(file))}  ${pc.dim(`${fmtBytes(size)} / ${lines} lines`)}`);
  }
  console.log(pc.dim(`  introspected schema: ${rel(path.join(previewDir, 'schema.ts'))} (and relations.ts)`));

  // ---- Step I: decide ----
  if (verifyOnly) {
    console.log(
      pc.green('\n[drizzleman] ✓ --verify-only: gate passed; not applying.'),
    );
    console.log(pc.dim(`  preview retained at ${rel(previewDir)}/.`));
    console.log(pc.dim(`  verify staging:    ${rel(verifyMigDir)}/`));
    if (existsSync(verifyIntroDir))
      console.log(pc.dim(`  verify introspect: ${rel(verifyIntroDir)}/`));
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 0;
  }
  if (appliedError) {
    console.log(
      pc.red(`\n[drizzleman] ✗ cannot apply: failed to read ${tableLabel} (${appliedError}).`),
    );
    console.log(pc.dim(`  preview retained at ${rel(previewDir)}/ for inspection.`));
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }

  if (!yes) {
    if (!process.stdin.isTTY) {
      console.log(
        pc.dim(
          `\nNon-TTY environment; preview retained at ${rel(previewDir)}/. Pass --yes to commit non-interactively.`,
        ),
      );
      printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
      return 0;
    }
    console.log('');
    const ok = await promptApply();
    if (!ok) {
      console.log(
        pc.dim(`[drizzleman] declined; preview retained at ${rel(previewDir)}/ for later inspection.`),
      );
      printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
      return 0;
    }
  }

  // ---- Step J: apply ----
  console.log(pc.bold('\n[drizzleman] Applying:'));

  // J1: backup existing migrations
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

  // J2: promote preview — split into migrations (sql + meta) and ref dir
  // (schema.ts / relations.ts / schema.sql) to keep migrations/ clean.
  console.log(`  promoting preview → ${rel(outDir)}/ (sql + meta) + ${rel(refDir)}/ (refs)`);
  try {
    let refMoved = 0;
    for (const entry of readdirSync(previewDir)) {
      if (REF_FILE_NAMES.has(entry)) {
        if (refMoved === 0) mkdirSync(refDir, { recursive: true });
        renameSync(path.join(previewDir, entry), path.join(refDir, entry));
        refMoved++;
      } else {
        renameSync(path.join(previewDir, entry), path.join(outDir, entry));
      }
    }
    rmdirSync(previewDir);
    if (refMoved > 0) {
      console.log(pc.dim(`  ✓ ${refMoved} reference file(s) → ${rel(refDir)}/`));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`  ✗ promotion failed mid-flight: ${msg}`));
    console.log(
      pc.red(
        `  Partial state: some files in ${rel(outDir)}/, some still in ${rel(previewDir)}/. Backup at ${rel(bakDir)}/ untouched. Recover manually.`,
      ),
    );
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  console.log(pc.green('  ✓ preview promoted'));

  // J3: reset DB migration table (with backup table)
  console.log(`  resetting ${tableLabel} (backup → ${bakTableLabel})`);
  try {
    await resetAppliedToRebase(
      config.dialect,
      config.dbCredentials,
      table,
      { hash: rebaseHash, createdAt: Date.now() },
      bakSlug,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`  ✗ DB reset failed: ${msg}`));
    console.log(
      pc.red(
        `  Filesystem is already swapped; DB rows untouched. Old rows in fs backup at ${rel(bakDir)}/applied.json. Investigate and retry resetAppliedToRebase by hand, or restore from backup.`,
      ),
    );
    printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
    return 1;
  }
  console.log(pc.green(`  ✓ ${tableLabel} reset; old rows preserved in ${bakTableLabel}`));

  console.log(pc.green('\n[drizzleman] ✓ rebase complete.'));
  if (deltaWritten) {
    console.log(`  next: ${pc.bold('drizzleman migrate')} to apply 0001_delta.sql against target.`);
  } else {
    console.log(pc.dim('  no pending migration; local schema already matches target.'));
  }
  console.log(pc.dim(`  fs backup:  ${rel(bakDir)}/`));
  console.log(pc.dim(`  db backup:  ${bakTableLabel}`));
  if (existsSync(refDir)) console.log(pc.dim(`  reference:  ${rel(refDir)}/ (schema.ts / relations.ts / schema.sql)`));
  printDbReminders(schemaDbUrl, verifyDbUrl, provisioned);
  return 0;
}

function printDbReminders(
  schemaDbUrl: string,
  verifyDbUrl: string,
  provisioned: { schema: string | null; verify: string | null },
): void {
  console.log(
    pc.dim(
      `\n  schema DB at ${pc.cyan(maskUrl(schemaDbUrl))} now contains a materialized copy of your local Drizzle schema.`,
    ),
  );
  console.log(
    pc.dim(
      `  verify DB at ${pc.cyan(maskUrl(verifyDbUrl))} was used to validate 0000+0001 against target/schema.`,
    ),
  );
  if (provisioned.schema || provisioned.verify) {
    console.log(pc.dim('  Both DBs were auto-created by drizzleman and are NOT auto-dropped. Clean up with:'));
    if (provisioned.schema) console.log(pc.dim(`    DROP DATABASE "${provisioned.schema}";`));
    if (provisioned.verify) console.log(pc.dim(`    DROP DATABASE "${provisioned.verify}";`));
  } else {
    console.log(pc.dim('  Drop / recycle both DBs yourself when finished inspecting.'));
  }
}
