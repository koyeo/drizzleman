import { createHash } from 'node:crypto';
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
const SCHEMADB_INTRO_PREFIX = '.baseline-schemadbintro-';
const ENV_SCHEMA_DB_URL = 'DRIZZLEMAN_EMPTY_SCHEMA_DB_URL';

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

function tableEntities(t: SnapshotTable, key: string): {
  tableKey: string;
  columns: Map<string, string>; // colName → column:<schema>.<table>.<col>
  indexes: Map<string, string>;
  fks: Map<string, string>;
} {
  const schema = tableSchema(t, key);
  const name = tableName(t, key);
  const qualified = `${schema}.${name}`;
  const tableKey = `table:${qualified}`;
  const columns = new Map<string, string>();
  for (const c of Object.keys(t.columns ?? {})) {
    columns.set(c, `column:${qualified}.${c}`);
  }
  const indexes = new Map<string, string>();
  for (const idxName of Object.keys(t.indexes ?? {})) {
    indexes.set(idxName, `index:${schema}.${idxName}`);
  }
  const fks = new Map<string, string>();
  for (const fkName of Object.keys(t.foreignKeys ?? {})) {
    fks.set(fkName, `fk:${qualified}.${fkName}`);
  }
  return { tableKey, columns, indexes, fks };
}

function diffSnapshots(target: SnapshotJson, schemaDb: SnapshotJson): SnapshotDiff {
  const onlyInTarget = emptyDiffSet();
  const onlyInSchemaDb = emptyDiffSet();

  const tT = target.tables ?? {};
  const tS = schemaDb.tables ?? {};

  // Tables (and contained columns/indexes/fks)
  for (const [key, def] of Object.entries(tT)) {
    const ents = tableEntities(def, key);
    if (!(key in tS)) {
      onlyInTarget.tables.push(ents.tableKey);
      for (const v of ents.columns.values()) onlyInTarget.columns.push(v);
      for (const v of ents.indexes.values()) onlyInTarget.indexes.push(v);
      for (const v of ents.fks.values()) onlyInTarget.foreignKeys.push(v);
    } else {
      const sDef = tS[key]!;
      const sEnts = tableEntities(sDef, key);
      for (const [c, k] of ents.columns) if (!sEnts.columns.has(c)) onlyInTarget.columns.push(k);
      for (const [i, k] of ents.indexes) if (!sEnts.indexes.has(i)) onlyInTarget.indexes.push(k);
      for (const [f, k] of ents.fks) if (!sEnts.fks.has(f)) onlyInTarget.foreignKeys.push(k);
    }
  }
  for (const [key, def] of Object.entries(tS)) {
    const ents = tableEntities(def, key);
    if (!(key in tT)) {
      onlyInSchemaDb.tables.push(ents.tableKey);
      for (const v of ents.columns.values()) onlyInSchemaDb.columns.push(v);
      for (const v of ents.indexes.values()) onlyInSchemaDb.indexes.push(v);
      for (const v of ents.fks.values()) onlyInSchemaDb.foreignKeys.push(v);
    } else {
      const tDef = tT[key]!;
      const tEnts = tableEntities(tDef, key);
      for (const [c, k] of ents.columns) if (!tEnts.columns.has(c)) onlyInSchemaDb.columns.push(k);
      for (const [i, k] of ents.indexes) if (!tEnts.indexes.has(i)) onlyInSchemaDb.indexes.push(k);
      for (const [f, k] of ents.fks) if (!tEnts.fks.has(f)) onlyInSchemaDb.foreignKeys.push(k);
    }
  }

  // Enums — snapshot keys are like "public.scan_status"
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

function buildDeltaSql(schemaDbChunks: SqlChunk[], diff: SnapshotDiff): string {
  const wantedTables = new Set(diff.onlyInSchemaDb.tables);
  const wantedIndexes = new Set(diff.onlyInSchemaDb.indexes);
  const wantedFks = new Set(diff.onlyInSchemaDb.foreignKeys);
  const wantedEnums = new Set(diff.onlyInSchemaDb.enums);

  const picked: string[] = [];
  for (const c of schemaDbChunks) {
    if (c.kind === 'enum' && wantedEnums.has(c.key)) picked.push(c.sql);
    else if (c.kind === 'table' && wantedTables.has(c.key)) picked.push(c.sql);
    else if (c.kind === 'index' && wantedIndexes.has(c.key)) {
      // skip if owner table is already wholly created
      if (c.ownerTableKey && wantedTables.has(c.ownerTableKey)) continue;
      picked.push(c.sql);
    } else if (c.kind === 'fk' && wantedFks.has(c.key)) {
      if (c.ownerTableKey && wantedTables.has(c.ownerTableKey)) continue;
      picked.push(c.sql);
    }
  }
  return picked.join('\n--> statement-breakpoint\n');
}

const SCHEMA_SQL_EMPTY = `-- schema.sql
-- (generated by drizzleman baseline)
-- target DB structure matches local schema; nothing to add.
`;

function buildSchemaSql(targetChunks: SqlChunk[], diff: SnapshotDiff): string {
  const wantedTables = new Set(diff.onlyInTarget.tables);
  const wantedIndexes = new Set(diff.onlyInTarget.indexes);
  const wantedFks = new Set(diff.onlyInTarget.foreignKeys);
  const wantedEnums = new Set(diff.onlyInTarget.enums);

  const picked: string[] = [];
  for (const c of targetChunks) {
    if (c.kind === 'enum' && wantedEnums.has(c.key)) picked.push(c.sql);
    else if (c.kind === 'table' && wantedTables.has(c.key)) picked.push(c.sql);
    else if (c.kind === 'index' && wantedIndexes.has(c.key)) {
      if (c.ownerTableKey && wantedTables.has(c.ownerTableKey)) continue;
      picked.push(c.sql);
    } else if (c.kind === 'fk' && wantedFks.has(c.key)) {
      if (c.ownerTableKey && wantedTables.has(c.ownerTableKey)) continue;
      picked.push(c.sql);
    }
  }
  if (picked.length === 0) return SCHEMA_SQL_EMPTY;
  const header = `-- schema.sql
-- (generated by drizzleman baseline)
-- DDL for entities present in target DB but missing from your local Drizzle schema.
-- Translate these to Drizzle DSL and add them to your schema files, then re-run baseline.
`;
  return `${header}\n${picked.join('\n--> statement-breakpoint\n')}\n`;
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

  // ---- Step C: push local schema to schema DB ----
  console.log(pc.bold(`\n[drizzleman] Step C: drizzle-kit push → schema DB`));
  const pushArgs = [
    'push',
    `--dialect=${config.dialect}`,
    ...buildSchemaArgs(config.schema),
    `--url=${schemaDbUrl}`,
    '--force',
  ];
  code = await passthrough(pushArgs);
  if (code !== 0) {
    console.log(pc.red(`[drizzleman] ✗ push exited ${code}; schema DB may be partially populated. Drop it and retry.`));
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
  const deltaSql = buildDeltaSql(schemaDbChunks, diff);
  const deltaFile = path.join(previewDir, '0001_delta.sql');
  if (deltaSql.length > 0) {
    writeFileSync(deltaFile, `${deltaSql}\n`);
  } else {
    writeFileSync(
      deltaFile,
      `-- 0001_delta.sql
-- (generated by drizzleman baseline)
-- local schema introduces no new entities vs target DB; nothing to migrate.
`,
    );
  }
  const schemaSql = buildSchemaSql(targetChunks, diff);
  const schemaFile = path.join(previewDir, 'schema.sql');
  writeFileSync(schemaFile, schemaSql);

  // ---- Step H: cleanup tmpDir, render preview ----
  cleanupDir(tmpDir);

  console.log(pc.bold('\n[drizzleman] Preview artifacts:'));
  for (const [label, file] of [
    [`  0000 ${pc.dim('(target DB structure, will be marked applied)')}`, baselineFile] as const,
    [`  0001 ${pc.dim('(delta from snapshot diff, PENDING)')}`, deltaFile] as const,
    [`  schema.sql ${pc.dim('(target-only entities; not a migration — paste into your local schema)')}`, schemaFile] as const,
  ]) {
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

  // J2: promote preview into migrations dir
  console.log(`  promoting preview → ${rel(outDir)}/`);
  try {
    for (const entry of readdirSync(previewDir)) {
      renameSync(path.join(previewDir, entry), path.join(outDir, entry));
    }
    rmdirSync(previewDir);
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
  console.log(`  next: ${pc.bold('drizzleman migrate')} to apply 0001_delta.sql (if non-empty)`);
  console.log(pc.dim(`  fs backup:  ${rel(bakDir)}/`));
  console.log(pc.dim(`  db backup:  ${bakTableLabel}`));
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
