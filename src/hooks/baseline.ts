import { createHash, randomUUID } from 'node:crypto';
import {
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
  resetAppliedToBaseline,
} from '../db/index.js';
import { passthrough } from '../passthrough.js';
import type { AppliedRow, DbCredentials, DrizzleConfig } from '../types.js';
import { targetUrl as renderUrl } from '../url.js';
import { preTarget } from './preTarget.js';

const PREVIEW_PREFIX = '.baseline-preview-';
const BAK_PREFIX = '.baseline-bak-';
const REF_PREFIX = '.baseline-ref-';
const SCHEMADB_INTRO_PREFIX = '.baseline-schemadbintro-';
const ENV_SCHEMA_DB_URL = 'DRIZZLEMAN_EMPTY_SCHEMA_DB_URL';

// Files that are NOT migrations themselves; they ship alongside the baseline
// as reference material. Promoted into `.baseline-ref-<ts>/` rather than the
// migrations dir proper.
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

interface BaselineFlags {
  yes: boolean;
  name: string;
  schemaDbUrl: string | null;
  rest: string[];
}

function consumeFlags(args: string[]): BaselineFlags {
  // Drop the leading 'baseline' command word so we don't accidentally forward it
  // to drizzle-kit's introspect/generate (brocli would reject it as an unknown option).
  const start = args[0] === 'baseline' ? 1 : 0;
  let yes = false;
  let name = 'baseline';
  let schemaDbUrl: string | null = null;
  const rest: string[] = [];
  for (let i = start; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--yes' || a === '-y') { yes = true; continue; }
    if (a === '--name') { name = args[++i] ?? name; continue; }
    if (a.startsWith('--name=')) { name = a.slice('--name='.length); continue; }
    if (a === '--empty-schema-db-url') { schemaDbUrl = args[++i] ?? null; continue; }
    if (a.startsWith('--empty-schema-db-url=')) {
      schemaDbUrl = a.slice('--empty-schema-db-url='.length);
      continue;
    }
    rest.push(a);
  }
  return { yes, name, schemaDbUrl, rest };
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

function renameBaselineTag(previewDir: string, slug: string): { oldTag: string; newTag: string } {
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
  type Bucket = 'pre' | 'type' | 'table' | 'index' | 'fk' | 'other';
  const buckets: Record<Bucket, string[]> = {
    pre: [],
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
    if (/^\s*CREATE\s+TYPE\s/i.test(trimmed)) buckets.type.push(raw);
    else if (/^\s*CREATE\s+(?:UNLOGGED\s+|TEMP\s+|TEMPORARY\s+)?TABLE\s/i.test(trimmed))
      buckets.table.push(raw);
    else if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s/i.test(trimmed)) buckets.index.push(raw);
    else if (/^\s*ALTER\s+TABLE\s+.+?\s+ADD\s+CONSTRAINT\s+"[^"]+"\s+FOREIGN\s+KEY/is.test(trimmed))
      buckets.fk.push(raw);
    else buckets.other.push(raw);
  }
  const ordered = [
    ...buckets.pre,
    ...buckets.type,
    ...buckets.table,
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

interface SnapshotTable {
  name?: string;
  schema?: string;
  columns?: Record<string, unknown>;
  indexes?: Record<string, unknown>;
  foreignKeys?: Record<string, unknown>;
  [k: string]: unknown;
}

interface DiffSet {
  tables: string[];           // entity key: table:<schema>.<name>
  columns: string[];          // column:<schema>.<table>.<col>
  indexes: string[];          // index:<schema>.<name>
  foreignKeys: string[];      // fk:<schema>.<table>.<constraint>
  enums: string[];            // enum:<schema>.<name>
}

interface SnapshotDiff {
  onlyInSchemaDb: DiffSet;
  onlyInTarget: DiffSet;
}

function emptyDiffSet(): DiffSet {
  return { tables: [], columns: [], indexes: [], foreignKeys: [], enums: [] };
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
  columnKeys: Map<string, string>;   // colName → column:<schema>.<table>.<col>
  fkSigs: Map<string, string>;       // structural signature → fk:<schema>.<table>.<name>
  indexSigs: Map<string, string>;    // structural signature → index:<schema>.<name>
}

function tableEntities(t: SnapshotTable, key: string): TableEntities {
  const schema = tableSchema(t, key);
  const name = tableName(t, key);
  const qualified = `${schema}.${name}`;
  const tableKey = `table:${qualified}`;

  const columnKeys = new Map<string, string>();
  for (const c of Object.keys(t.columns ?? {})) {
    columnKeys.set(c, `column:${qualified}.${c}`);
  }

  const fkSigs = new Map<string, string>();
  for (const [fkName, fk] of Object.entries(t.foreignKeys ?? {})) {
    const sig = fkSignature(fk as SnapshotFk, schema);
    fkSigs.set(sig, `fk:${qualified}.${fkName}`);
  }

  const indexSigs = new Map<string, string>();
  for (const [idxName, idx] of Object.entries(t.indexes ?? {})) {
    const sig = indexSignature(idx as SnapshotIdx, schema, name);
    indexSigs.set(sig, `index:${schema}.${idxName}`);
  }

  return { tableKey, columnKeys, fkSigs, indexSigs };
}

function diffSnapshots(target: SnapshotJson, schemaDb: SnapshotJson): SnapshotDiff {
  const onlyInTarget = emptyDiffSet();
  const onlyInSchemaDb = emptyDiffSet();

  const tT = target.tables ?? {};
  const tS = schemaDb.tables ?? {};

  // Tables (by qualified key); columns by name; fks/indexes by structural signature.
  for (const [key, def] of Object.entries(tT)) {
    const ents = tableEntities(def, key);
    if (!(key in tS)) {
      onlyInTarget.tables.push(ents.tableKey);
      for (const v of ents.columnKeys.values()) onlyInTarget.columns.push(v);
      for (const v of ents.indexSigs.values()) onlyInTarget.indexes.push(v);
      for (const v of ents.fkSigs.values()) onlyInTarget.foreignKeys.push(v);
    } else {
      const sEnts = tableEntities(tS[key]!, key);
      for (const [c, k] of ents.columnKeys) if (!sEnts.columnKeys.has(c)) onlyInTarget.columns.push(k);
      for (const [sig, k] of ents.indexSigs) if (!sEnts.indexSigs.has(sig)) onlyInTarget.indexes.push(k);
      for (const [sig, k] of ents.fkSigs) if (!sEnts.fkSigs.has(sig)) onlyInTarget.foreignKeys.push(k);
    }
  }
  for (const [key, def] of Object.entries(tS)) {
    const ents = tableEntities(def, key);
    if (!(key in tT)) {
      onlyInSchemaDb.tables.push(ents.tableKey);
      for (const v of ents.columnKeys.values()) onlyInSchemaDb.columns.push(v);
      for (const v of ents.indexSigs.values()) onlyInSchemaDb.indexes.push(v);
      for (const v of ents.fkSigs.values()) onlyInSchemaDb.foreignKeys.push(v);
    } else {
      const tEnts = tableEntities(tT[key]!, key);
      for (const [c, k] of ents.columnKeys) if (!tEnts.columnKeys.has(c)) onlyInSchemaDb.columns.push(k);
      for (const [sig, k] of ents.indexSigs) if (!tEnts.indexSigs.has(sig)) onlyInSchemaDb.indexes.push(k);
      for (const [sig, k] of ents.fkSigs) if (!tEnts.fkSigs.has(sig)) onlyInSchemaDb.foreignKeys.push(k);
    }
  }

  // Enums — keyed by qualified name. Value-list mismatches (same name, different
  // members) are not currently diffed; future work.
  const eT = new Set(Object.keys(target.enums ?? {}));
  const eS = new Set(Object.keys(schemaDb.enums ?? {}));
  for (const k of eT) if (!eS.has(k)) onlyInTarget.enums.push(`enum:${k}`);
  for (const k of eS) if (!eT.has(k)) onlyInSchemaDb.enums.push(`enum:${k}`);

  return { onlyInTarget, onlyInSchemaDb };
}

// ---- SQL chunker ----

interface SqlChunk {
  key: string;          // entity key, e.g. table:public.users
  kind: 'enum' | 'table' | 'index' | 'fk';
  sql: string;          // full statement including trailing semicolon
  ownerTableKey?: string; // for fk/index: table:<schema>.<name> they belong to
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

// FK-safe execution order: enum → table → index → fk. Stable-sort within each
// kind preserves the introspect-source ordering. This matters for any consumer
// that executes the SQL as a single transaction (drizzle-kit migrate for 0001,
// or a human pasting schema.sql wholesale into target).
const KIND_ORDER: Record<SqlChunk['kind'], number> = {
  enum: 0,
  table: 1,
  index: 2,
  fk: 3,
};

function pickAndOrder(
  chunks: SqlChunk[],
  wanted: {
    tables: Set<string>;
    indexes: Set<string>;
    fks: Set<string>;
    enums: Set<string>;
  },
): SqlChunk[] {
  const picked: SqlChunk[] = [];
  for (const c of chunks) {
    if (c.kind === 'enum' && wanted.enums.has(c.key)) picked.push(c);
    else if (c.kind === 'table' && wanted.tables.has(c.key)) picked.push(c);
    else if (c.kind === 'index' && wanted.indexes.has(c.key)) {
      // skip if owner table is already wholly created
      if (c.ownerTableKey && wanted.tables.has(c.ownerTableKey)) continue;
      picked.push(c);
    } else if (c.kind === 'fk' && wanted.fks.has(c.key)) {
      if (c.ownerTableKey && wanted.tables.has(c.ownerTableKey)) continue;
      picked.push(c);
    }
  }
  picked.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  return picked;
}

function buildDeltaSql(schemaDbChunks: SqlChunk[], diff: SnapshotDiff): string {
  const picked = pickAndOrder(schemaDbChunks, {
    tables: new Set(diff.onlyInSchemaDb.tables),
    indexes: new Set(diff.onlyInSchemaDb.indexes),
    fks: new Set(diff.onlyInSchemaDb.foreignKeys),
    enums: new Set(diff.onlyInSchemaDb.enums),
  });
  return picked.map((c) => c.sql).join('\n--> statement-breakpoint\n');
}

const SCHEMA_SQL_EMPTY = `-- schema.sql
-- (generated by drizzleman baseline)
-- target DB structure matches local schema; nothing to add.
`;

function buildSchemaSql(targetChunks: SqlChunk[], diff: SnapshotDiff): string {
  const picked = pickAndOrder(targetChunks, {
    tables: new Set(diff.onlyInTarget.tables),
    indexes: new Set(diff.onlyInTarget.indexes),
    fks: new Set(diff.onlyInTarget.foreignKeys),
    enums: new Set(diff.onlyInTarget.enums),
  });
  if (picked.length === 0) return SCHEMA_SQL_EMPTY;
  const header = `-- schema.sql
-- (generated by drizzleman baseline)
-- DDL for entities present in target DB but missing from your local Drizzle schema.
-- Translate these to Drizzle DSL and add them to your schema files, then re-run baseline.
`;
  return `${header}\n${picked.map((c) => c.sql).join('\n--> statement-breakpoint\n')}\n`;
}

function fmtDiffSet(d: DiffSet): string {
  return `tables=${d.tables.length} columns=${d.columns.length} indexes=${d.indexes.length} fks=${d.foreignKeys.length} enums=${d.enums.length}`;
}

function readSnapshot(dir: string): SnapshotJson {
  const p = path.join(dir, 'meta', '0000_snapshot.json');
  return JSON.parse(readFileSync(p, 'utf8')) as SnapshotJson;
}

// ---- main ----

export async function runBaseline(args: string[]): Promise<number> {
  const { yes, name, schemaDbUrl: schemaDbUrlFromFlag, rest } = consumeFlags(args);
  const schemaDbUrl =
    schemaDbUrlFromFlag ?? process.env[ENV_SCHEMA_DB_URL] ?? null;
  if (!schemaDbUrl) {
    console.log(
      pc.red(
        `[drizzleman] ✗ --empty-schema-db-url is required (or set ${ENV_SCHEMA_DB_URL}).`,
      ),
    );
    console.log(
      pc.dim(
        `  Provide a brand-new empty Postgres DB. drizzleman will push your local Drizzle schema there, introspect it, and diff against your target DB to build 0000/0001/schema.sql. Drop the schema DB yourself afterwards.`,
      ),
    );
    return 1;
  }

  const config = await preTarget(rest);
  if (!config.schema) {
    console.log(
      pc.red(
        `[drizzleman] ✗ drizzle config has no 'schema' field; cannot push local schema to schema DB. Add e.g. schema: './src/schema/index.ts' and retry.`,
      ),
    );
    return 1;
  }

  const outDir = path.resolve(process.cwd(), config.out);
  const table = migrationsTableOf(config);
  const tableLabel = `${table.schema ? `${table.schema}.` : ''}${table.table}`;

  const ts = Date.now();
  const previewName = `${PREVIEW_PREFIX}${ts}`;
  const previewDir = path.join(outDir, previewName);
  const tmpDir = path.join(outDir, `${SCHEMADB_INTRO_PREFIX}${ts}`);
  const bakSlug = `baseline-bak-${ts}`;
  const bakDir = path.join(outDir, `.${bakSlug}`);
  const refSlug = `baseline-ref-${ts}`;
  const refDir = path.join(outDir, `.${refSlug}`);
  const bakTableLabel = `${table.schema ? `${table.schema}.` : ''}${bakSlug}`;

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  if (existsSync(previewDir)) {
    console.log(pc.red(`[drizzleman] ✗ preview dir already exists: ${rel(previewDir)}; remove it and retry.`));
    return 1;
  }
  if (existsSync(tmpDir)) {
    console.log(pc.red(`[drizzleman] ✗ schema-db introspect dir already exists: ${rel(tmpDir)}; remove it and retry.`));
    return 1;
  }

  console.log(pc.dim(`[drizzleman] Schema DB: ${pc.cyan(maskUrl(schemaDbUrl))}`));

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
      !n.startsWith(SCHEMADB_INTRO_PREFIX),
  );

  console.log(pc.bold('[drizzleman] Current state:'));
  console.log(`  existing entries in ${rel(outDir)}/ : ${pc.cyan(String(existingMigrationFiles.length))}`);
  if (appliedError) {
    console.log(`  DB rows in ${tableLabel}            : ${pc.yellow('(read failed)')} ${pc.dim(appliedError)}`);
  } else {
    console.log(`  DB rows in ${tableLabel}            : ${pc.cyan(String(applied.length))}`);
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
    return 1;
  }

  let renameInfo: { oldTag: string; newTag: string };
  try {
    renameInfo = renameBaselineTag(previewDir, name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`[drizzleman] ✗ failed to rename baseline tag: ${msg}`));
    cleanupDir(previewDir);
    return 1;
  }
  if (renameInfo.oldTag !== renameInfo.newTag) {
    console.log(pc.dim(`  renamed ${renameInfo.oldTag} → ${renameInfo.newTag}`));
  }
  const baselineFile = path.join(previewDir, `${renameInfo.newTag}.sql`);
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
    const reordered = reorderForFkSafety(stripped);
    if (reordered !== raw) {
      writeFileSync(baselineFile, reordered);
      const notes: string[] = [];
      if (stripped !== raw) notes.push('unwrapped /* ... */');
      if (reordered !== stripped) notes.push('reordered CREATE INDEX before ALTER ADD FK');
      console.log(pc.dim(`  rewrote 0000 (${notes.join(', ')})`));
    }
  }
  const baselineHash = hashFile(baselineFile);

  // ---- Step B: assert schema DB is empty ----
  console.log(pc.bold(`\n[drizzleman] Step B: assert schema DB is empty`));
  try {
    await assertSchemaDbEmpty(config.dialect, { url: schemaDbUrl });
    console.log(pc.green('  ✓ schema DB has no user-schema tables'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`  ✗ ${msg}`));
    cleanupDir(previewDir);
    return 1;
  }

  // ---- Step C: materialize local schema to schema DB via generate + migrate ----
  // We deliberately avoid `drizzle-kit push` — in 0.31.5 it silently drops indexes
  // declared in pgTable's second-arg callback (and some FKs), yielding a fake schema
  // DB snapshot that under-reports local schema. `generate` produces canonical SQL
  // covering everything; `migrate` then applies it via drizzle-kit's own runner.
  console.log(pc.bold(`\n[drizzleman] Step C: drizzle-kit generate → migrate (schema DB)`));
  const tmpgenDir = path.join('/tmp', `drizzleman-baseline-tmpgen-${ts}`);
  if (existsSync(tmpgenDir)) {
    console.log(pc.red(`[drizzleman] ✗ tmpgen dir already exists: ${tmpgenDir}; remove it and retry.`));
    cleanupDir(previewDir);
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
    return 1;
  }
  console.log(`  onlyInSchemaDb (→ 0001_delta.sql): ${pc.cyan(fmtDiffSet(diff.onlyInSchemaDb))}`);
  console.log(`  onlyInTarget   (→ schema.sql)   : ${pc.cyan(fmtDiffSet(diff.onlyInTarget))}`);

  // ---- Step F: chunk both 0000 SQLs ----
  const targetSqlPath = baselineFile;
  const schemaDbJournal = readPreviewJournal(tmpDir);
  if (schemaDbJournal.length !== 1 || schemaDbJournal[0]!.idx !== 0) {
    console.log(pc.red(`  ✗ unexpected journal in schema-db introspect dir (entries=${schemaDbJournal.length})`));
    cleanupDir(tmpDir);
    cleanupDir(previewDir);
    return 1;
  }
  const schemaDbSqlPath = path.join(tmpDir, `${schemaDbJournal[0]!.tag}.sql`);
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
  if (appliedError) {
    console.log(
      pc.red(`\n[drizzleman] ✗ cannot apply: failed to read ${tableLabel} (${appliedError}).`),
    );
    console.log(pc.dim(`  preview retained at ${rel(previewDir)}/ for inspection.`));
    printSchemaDbReminder(schemaDbUrl);
    return 1;
  }

  if (!yes) {
    if (!process.stdin.isTTY) {
      console.log(
        pc.dim(
          `\nNon-TTY environment; preview retained at ${rel(previewDir)}/. Pass --yes to commit non-interactively.`,
        ),
      );
      printSchemaDbReminder(schemaDbUrl);
      return 0;
    }
    console.log('');
    const ok = await promptApply();
    if (!ok) {
      console.log(
        pc.dim(`[drizzleman] declined; preview retained at ${rel(previewDir)}/ for later inspection.`),
      );
      printSchemaDbReminder(schemaDbUrl);
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
    printSchemaDbReminder(schemaDbUrl);
    return 1;
  }
  console.log(pc.green('  ✓ preview promoted'));

  // J3: reset DB migration table (with backup table)
  console.log(`  resetting ${tableLabel} (backup → ${bakTableLabel})`);
  try {
    await resetAppliedToBaseline(
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
        `  Filesystem is already swapped; DB rows untouched. Old rows in fs backup at ${rel(bakDir)}/applied.json. Investigate and retry resetAppliedToBaseline by hand, or restore from backup.`,
      ),
    );
    printSchemaDbReminder(schemaDbUrl);
    return 1;
  }
  console.log(pc.green(`  ✓ ${tableLabel} reset; old rows preserved in ${bakTableLabel}`));

  console.log(pc.green('\n[drizzleman] ✓ baseline complete.'));
  if (deltaWritten) {
    console.log(`  next: ${pc.bold('drizzleman migrate')} to apply 0001_delta.sql against target.`);
  } else {
    console.log(pc.dim('  no pending migration; local schema already matches target.'));
  }
  console.log(pc.dim(`  fs backup:  ${rel(bakDir)}/`));
  console.log(pc.dim(`  db backup:  ${bakTableLabel}`));
  if (existsSync(refDir)) console.log(pc.dim(`  reference:  ${rel(refDir)}/ (schema.ts / relations.ts / schema.sql)`));
  printSchemaDbReminder(schemaDbUrl);
  return 0;
}

function printSchemaDbReminder(url: string): void {
  console.log(
    pc.dim(
      `\n  schema DB at ${pc.cyan(maskUrl(url))} now contains a materialized copy of your local Drizzle schema — please drop / recycle it yourself.`,
    ),
  );
}
