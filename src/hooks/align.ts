import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { migrationsTableOf } from '../config.js';
import { readApplied } from '../db/index.js';
import { formatIdxIssues, hasIdxIssues, idxIssues, idxTagMismatches, readJournal } from '../journal.js';
import type { JournalEntry } from '../types.js';
import { renderTable } from '../ui/table.js';
import { runCheckMigrations } from './checkMigrations.js';
import { diff } from './diff.js';
import { preTarget } from './preTarget.js';

interface AlignPlan {
  idx: number;
  oldTag: string;
  newTag: string;
  oldSqlFile: string;
  newSqlFile: string;
  oldSnapshotFile: string | null;
  newSnapshotFile: string | null;
}

export function consumeApplyFlag(args: string[]): { apply: boolean; rest: string[] } {
  let apply = false;
  const rest: string[] = [];
  for (const a of args) {
    if (a === '--apply') {
      apply = true;
      continue;
    }
    rest.push(a);
  }
  return { apply, rest };
}

function buildPlans(out: string, journal: JournalEntry[]): AlignPlan[] {
  const mismatches = idxTagMismatches(journal);
  const outDir = path.resolve(process.cwd(), out);
  const metaDir = path.join(outDir, 'meta');
  return mismatches.map((m) => {
    const entry = journal.find((e) => e.idx === m.idx)!;
    const underscoreAt = entry.tag.indexOf('_');
    const suffix = underscoreAt >= 0 ? entry.tag.slice(underscoreAt + 1) : '';
    const newPrefix = String(entry.idx).padStart(4, '0');
    const newTag = suffix ? `${newPrefix}_${suffix}` : newPrefix;
    const oldPrefix = String(m.tagPrefix).padStart(4, '0');
    const oldSql = path.join(outDir, `${entry.tag}.sql`);
    const newSql = path.join(outDir, `${newTag}.sql`);
    const oldSnap = path.join(metaDir, `${oldPrefix}_snapshot.json`);
    const newSnap = path.join(metaDir, `${newPrefix}_snapshot.json`);
    const snapExists = existsSync(oldSnap);
    return {
      idx: m.idx,
      oldTag: entry.tag,
      newTag,
      oldSqlFile: oldSql,
      newSqlFile: newSql,
      oldSnapshotFile: snapExists ? oldSnap : null,
      newSnapshotFile: snapExists ? newSnap : null,
    };
  });
}

function tempSql(dir: string, idx: number): string {
  return path.join(dir, `__drizzleman_align__${String(idx).padStart(4, '0')}.sql`);
}

function tempSnap(dir: string, idx: number): string {
  return path.join(dir, `__drizzleman_align__${String(idx).padStart(4, '0')}_snapshot.json`);
}

function applyPlans(out: string, plans: AlignPlan[]): void {
  const outDir = path.resolve(process.cwd(), out);
  const metaDir = path.join(outDir, 'meta');
  const journalPath = path.join(metaDir, '_journal.json');

  // Pre-flight: no temp name may pre-exist (extremely unlikely; defensive).
  for (const p of plans) {
    const tSql = tempSql(outDir, p.idx);
    if (existsSync(tSql)) throw new Error(`align refused: temp file exists ${tSql}`);
    if (p.oldSnapshotFile) {
      const tSnap = tempSnap(metaDir, p.idx);
      if (existsSync(tSnap)) throw new Error(`align refused: temp file exists ${tSnap}`);
    }
  }

  // Backup journal.
  const bakPath = `${journalPath}.bak.${Date.now()}`;
  copyFileSync(journalPath, bakPath);
  console.log(pc.dim(`  backup: ${bakPath}`));

  // Pass 1: rename live → temp.
  for (const p of plans) {
    renameSync(p.oldSqlFile, tempSql(outDir, p.idx));
    if (p.oldSnapshotFile) renameSync(p.oldSnapshotFile, tempSnap(metaDir, p.idx));
  }

  // Pass 2: temp → final.
  for (const p of plans) {
    renameSync(tempSql(outDir, p.idx), p.newSqlFile);
    if (p.oldSnapshotFile && p.newSnapshotFile) {
      renameSync(tempSnap(metaDir, p.idx), p.newSnapshotFile);
    }
  }

  // Update journal: only touch the `tag` field for affected idx values.
  const rawJournal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number; tag: string; [k: string]: unknown }>;
  };
  const newTagByIdx = new Map(plans.map((p) => [p.idx, p.newTag]));
  for (const e of rawJournal.entries) {
    const t = newTagByIdx.get(e.idx);
    if (t !== undefined) e.tag = t;
  }
  writeFileSync(journalPath, JSON.stringify(rawJournal, null, 2));
}

export async function runAlign(args: string[]): Promise<number> {
  const { apply, rest } = consumeApplyFlag(args);
  const config = await preTarget(rest);
  const journal = readJournal(config.out);

  const idxState = idxIssues(journal);
  if (hasIdxIssues(idxState)) {
    console.log(pc.red(`[drizzleman] ✗ Journal idx not contiguous: ${formatIdxIssues(idxState)}`));
    console.log(
      pc.dim(
        `  align renames files to match each entry's idx; gaps/duplicates would either leave holes or produce colliding filenames. Reconcile journal idx (so set(idx) == {0..${journal.length - 1}}) before running align.`,
      ),
    );
    return 1;
  }

  const mismatches = idxTagMismatches(journal);
  if (mismatches.length === 0) {
    console.log(pc.green('[drizzleman] ✓ already aligned (no idx ≠ tag prefix mismatches).'));
    return 0;
  }

  const plans = buildPlans(config.out, journal);

  console.log(
    pc.bold(`[drizzleman] Align plan (${plans.length} entr${plans.length === 1 ? 'y' : 'ies'}):`),
  );
  const rows = plans.map((p) => [
    String(p.idx).padStart(4, '0'),
    `${pc.cyan(p.oldTag)} → ${pc.green(p.newTag)}`,
    `${path.basename(p.oldSqlFile)} → ${path.basename(p.newSqlFile)}`,
    p.oldSnapshotFile && p.newSnapshotFile
      ? `${path.basename(p.oldSnapshotFile)} → ${path.basename(p.newSnapshotFile)}`
      : pc.dim('(no snapshot)'),
  ]);
  console.log(renderTable(['idx', 'tag rename', 'sql file', 'snapshot file'], rows));

  if (!apply) {
    console.log(pc.dim('Dry run. Pass --apply to execute.'));
    return 0;
  }

  // Safety gate (only when about to mutate): refuse if DB drifted / has extras.
  const applied = await readApplied(config.dialect, config.dbCredentials, migrationsTableOf(config));
  const d = diff(journal, applied);
  if (d.drifted.length > 0 || d.dbExtra.length > 0) {
    console.log(
      pc.red(
        `[drizzleman] ✗ refusing to apply: DB has drift=${d.drifted.length} db-extra=${d.dbExtra.length}. Run 'drizzleman check-migrations' to inspect, reconcile, and retry.`,
      ),
    );
    return 1;
  }

  console.log(pc.bold('[drizzleman] Applying...'));
  try {
    applyPlans(config.out, plans);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`[drizzleman] ✗ align failed mid-flight: ${msg}`));
    console.log(pc.red(`  state may be partially renamed; check temp files (__drizzleman_align__*) and journal .bak.<ts> to recover.`));
    return 1;
  }
  console.log(pc.green('[drizzleman] ✓ files / journal updated.'));

  console.log(pc.bold('[drizzleman] Verifying with check-migrations...'));
  const code = await runCheckMigrations(rest);
  if (code !== 0) {
    console.log(
      pc.red(`[drizzleman] ✗ post-align check failed; see output above. Backup at ${path.join(config.out, 'meta/_journal.json.bak.<ts>')}.`),
    );
    return code;
  }
  return 0;
}
