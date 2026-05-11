import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { migrationsTableOf } from '../config.js';
import { readApplied } from '../db/index.js';
import { readJournal } from '../journal.js';
import { readSnapshots, walkChain } from '../snapshot.js';
import type { JournalEntry } from '../types.js';
import { renderTable } from '../ui/table.js';
import { consumeApplyFlag } from './align.js';
import { runCheckMigrations } from './checkMigrations.js';
import { diff } from './diff.js';
import { preTarget } from './preTarget.js';

interface RenumberPlan {
  oldIdx: number;
  newIdx: number;
  oldTag: string;
  newTag: string;
  oldSqlFile: string;
  newSqlFile: string;
  oldSnapshotFile: string | null;
  newSnapshotFile: string | null;
}

function buildPlans(out: string, canonical: JournalEntry[]): RenumberPlan[] {
  const outDir = path.resolve(process.cwd(), out);
  const metaDir = path.join(outDir, 'meta');
  const plans: RenumberPlan[] = [];
  canonical.forEach((entry, newIdx) => {
    const underscoreAt = entry.tag.indexOf('_');
    const suffix = underscoreAt >= 0 ? entry.tag.slice(underscoreAt + 1) : '';
    const newPrefixPadded = String(newIdx).padStart(4, '0');
    const newTag = suffix ? `${newPrefixPadded}_${suffix}` : newPrefixPadded;
    if (entry.idx === newIdx && entry.tag === newTag) return;

    const oldPrefixNum = parseInt(entry.tag.split('_')[0] ?? '', 10);
    const oldPrefixPadded = String(
      Number.isNaN(oldPrefixNum) ? entry.idx : oldPrefixNum,
    ).padStart(4, '0');

    const oldSql = path.join(outDir, `${entry.tag}.sql`);
    const newSql = path.join(outDir, `${newTag}.sql`);
    const oldSnap = path.join(metaDir, `${oldPrefixPadded}_snapshot.json`);
    const newSnap = path.join(metaDir, `${newPrefixPadded}_snapshot.json`);
    const snapExists = existsSync(oldSnap);
    plans.push({
      oldIdx: entry.idx,
      newIdx,
      oldTag: entry.tag,
      newTag,
      oldSqlFile: oldSql,
      newSqlFile: newSql,
      oldSnapshotFile: snapExists ? oldSnap : null,
      newSnapshotFile: snapExists ? newSnap : null,
    });
  });
  return plans;
}

function tempSql(dir: string, newIdx: number): string {
  return path.join(dir, `__drizzleman_renumber__${String(newIdx).padStart(4, '0')}.sql`);
}

function tempSnap(dir: string, newIdx: number): string {
  return path.join(dir, `__drizzleman_renumber__${String(newIdx).padStart(4, '0')}_snapshot.json`);
}

function applyPlans(out: string, plans: RenumberPlan[]): string {
  const outDir = path.resolve(process.cwd(), out);
  const metaDir = path.join(outDir, 'meta');
  const journalPath = path.join(metaDir, '_journal.json');

  for (const p of plans) {
    const tSql = tempSql(outDir, p.newIdx);
    if (existsSync(tSql)) throw new Error(`renumber refused: temp file exists ${tSql}`);
    if (p.oldSnapshotFile) {
      const tSnap = tempSnap(metaDir, p.newIdx);
      if (existsSync(tSnap)) throw new Error(`renumber refused: temp file exists ${tSnap}`);
    }
  }

  const bakPath = `${journalPath}.bak.${Date.now()}`;
  copyFileSync(journalPath, bakPath);
  console.log(pc.dim(`  backup: ${bakPath}`));

  for (const p of plans) {
    renameSync(p.oldSqlFile, tempSql(outDir, p.newIdx));
    if (p.oldSnapshotFile) renameSync(p.oldSnapshotFile, tempSnap(metaDir, p.newIdx));
  }
  for (const p of plans) {
    renameSync(tempSql(outDir, p.newIdx), p.newSqlFile);
    if (p.oldSnapshotFile && p.newSnapshotFile) {
      renameSync(tempSnap(metaDir, p.newIdx), p.newSnapshotFile);
    }
  }

  const rawJournal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ idx: number; tag: string; [k: string]: unknown }>;
  };
  // Match journal entries to plans by oldTag (tags are unique even when idx duplicates exist).
  const byOldTag = new Map(plans.map((p) => [p.oldTag, p]));
  for (const e of rawJournal.entries) {
    const p = byOldTag.get(e.tag);
    if (p) {
      e.idx = p.newIdx;
      e.tag = p.newTag;
    }
  }
  rawJournal.entries.sort((a, b) => a.idx - b.idx);
  writeFileSync(journalPath, JSON.stringify(rawJournal, null, 2));
  return bakPath;
}

export async function runRenumber(args: string[]): Promise<number> {
  const { apply, rest } = consumeApplyFlag(args);
  const config = await preTarget(rest);
  const journal = readJournal(config.out);

  if (journal.length === 0) {
    console.log(pc.green('[drizzleman] ✓ no migrations to renumber.'));
    return 0;
  }

  const snapshots = readSnapshots(config.out);
  const chain = walkChain(snapshots);

  const entryByPrefix = new Map<number, JournalEntry>();
  for (const e of journal) {
    const prefix = parseInt(e.tag.split('_')[0] ?? '', 10);
    if (!Number.isNaN(prefix)) entryByPrefix.set(prefix, e);
  }
  const snapshotPrefixes = new Set(snapshots.map((s) => s.filePrefix));
  const mappingIssues: string[] = [];
  for (const e of journal) {
    const prefix = parseInt(e.tag.split('_')[0] ?? '', 10);
    if (Number.isNaN(prefix) || !snapshotPrefixes.has(prefix)) {
      mappingIssues.push(`journal entry ${e.tag} (idx=${e.idx}) has no matching snapshot`);
    }
  }
  for (const s of snapshots) {
    if (!entryByPrefix.has(s.filePrefix)) {
      mappingIssues.push(`snapshot ${path.basename(s.file)} has no matching journal entry`);
    }
  }

  // Chain is clean linear: map each snapshot to its journal entry (by file prefix) — that becomes canonical order.
  // Only safe to compute if chain & mapping are clean; otherwise canonical entries may be undefined.
  const canonical: JournalEntry[] =
    chain.issues.length === 0 && mappingIssues.length === 0
      ? chain.order.map((s) => entryByPrefix.get(s.filePrefix)!)
      : [];

  // Cross-check: chain order must also be non-decreasing in `when`.
  // If chain says A → B but A.when > B.when, someone hand-edited timestamps and the two orderings disagree.
  interface WhenDisagreement { position: number; left: JournalEntry; right: JournalEntry }
  const whenDisagreements: WhenDisagreement[] = [];
  for (let i = 0; i < canonical.length - 1; i++) {
    const a = canonical[i]!;
    const b = canonical[i + 1]!;
    if (a.when > b.when) whenDisagreements.push({ position: i, left: a, right: b });
  }

  if (chain.issues.length > 0 || mappingIssues.length > 0 || whenDisagreements.length > 0) {
    console.log(pc.red('[drizzleman] ✗ refusing to renumber: snapshot chain / journal not in a clean state.'));
    if (chain.issues.length > 0) {
      console.log(pc.bold('Snapshot chain issues:'));
      for (const i of chain.issues) {
        console.log(`  - ${pc.red(i.kind)}: ${i.detail}`);
      }
    }
    if (mappingIssues.length > 0) {
      console.log(pc.bold('Journal ↔ snapshot mapping issues:'));
      for (const m of mappingIssues) console.log(`  - ${pc.red(m)}`);
    }
    if (whenDisagreements.length > 0) {
      console.log(pc.bold('Chain order disagrees with `when` order:'));
      for (const d of whenDisagreements) {
        console.log(
          `  - position ${pc.yellow(String(d.position))}→${pc.yellow(String(d.position + 1))}: chain says ${pc.cyan(d.left.tag)} (when=${d.left.when}) precedes ${pc.cyan(d.right.tag)} (when=${d.right.when}), but ${d.left.tag}.when > ${d.right.tag}.when`,
        );
      }
    }
    console.log(
      pc.dim(
        '  Fork → regenerate the later branch via `drizzle-kit generate` (re-diffs against merged tip, fresh prevId). When/chain mismatch → correct the hand-edited `when` so it agrees with prevId order. Retry renumber after fixing.',
      ),
    );
    return 1;
  }

  const plans = buildPlans(config.out, canonical);
  if (plans.length === 0) {
    console.log(pc.green('[drizzleman] ✓ already canonical (idx == when-sorted position, tag prefix matches idx).'));
    return 0;
  }

  console.log(
    pc.bold(`[drizzleman] Renumber plan (${plans.length} entr${plans.length === 1 ? 'y' : 'ies'}):`),
  );
  const rows = plans.map((p) => [
    `${pc.yellow(String(p.oldIdx).padStart(4, '0'))} → ${pc.green(String(p.newIdx).padStart(4, '0'))}`,
    `${pc.cyan(p.oldTag)} → ${pc.green(p.newTag)}`,
    `${path.basename(p.oldSqlFile)} → ${path.basename(p.newSqlFile)}`,
    p.oldSnapshotFile && p.newSnapshotFile
      ? `${path.basename(p.oldSnapshotFile)} → ${path.basename(p.newSnapshotFile)}`
      : pc.dim('(no snapshot)'),
  ]);
  console.log(renderTable(['idx (old → new)', 'tag rename', 'sql file', 'snapshot file'], rows));

  if (!apply) {
    console.log(pc.dim('Dry run. Pass --apply to execute.'));
    return 0;
  }

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
  let bakPath: string;
  try {
    bakPath = applyPlans(config.out, plans);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`[drizzleman] ✗ renumber failed mid-flight: ${msg}`));
    console.log(
      pc.red(`  state may be partially renamed; check temp files (__drizzleman_renumber__*) and journal .bak.<ts> to recover.`),
    );
    return 1;
  }
  console.log(pc.green('[drizzleman] ✓ files / journal updated.'));

  console.log(pc.bold('[drizzleman] Verifying with check-migrations...'));
  const code = await runCheckMigrations(rest);
  if (code !== 0) {
    console.log(
      pc.red(`[drizzleman] ✗ post-renumber check failed; see output above. Backup retained at ${bakPath}.`),
    );
    return code;
  }
  unlinkSync(bakPath);
  console.log(pc.dim(`  removed backup: ${bakPath}`));
  return 0;
}
