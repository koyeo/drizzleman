import path from 'node:path';
import pc from 'picocolors';
import { readJournal, tagPrefixDuplicates } from '../journal.js';
import { readSnapshots, walkChain } from '../snapshot.js';
import type { JournalEntry } from '../types.js';
import { preTarget } from './preTarget.js';

export async function runCheckChain(args: string[]): Promise<number> {
  const config = await preTarget(args);
  const journal = readJournal(config.out);
  const snapshots = readSnapshots(config.out);

  console.log(pc.bold(`[drizzleman] Chain audit:`));
  console.log(`  Snapshots on disk:  ${pc.cyan(String(snapshots.length))}`);
  console.log(`  Journal entries:    ${pc.cyan(String(journal.length))}`);

  if (snapshots.length === 0) {
    console.log(pc.yellow('  (no snapshot files found — nothing to audit)'));
    return journal.length === 0 ? 0 : 1;
  }

  const chain = walkChain(snapshots);
  const reachableFiles = new Set(chain.order.map((s) => s.file));

  console.log();
  console.log(pc.bold('Chain walk (from genesis, following prevId children):'));
  if (chain.order.length === 0) {
    console.log(pc.red('  no genesis snapshot found — chain cannot start'));
  } else {
    const genesis = chain.order[0]!;
    const tip = chain.order[chain.order.length - 1]!;
    console.log(`  Reachable from genesis:  ${pc.cyan(String(chain.order.length))} / ${snapshots.length}`);
    console.log(`  Genesis:                 ${path.basename(genesis.file)}  ${pc.dim(`(id=${genesis.id.slice(0, 8)}…)`)}`);
    console.log(`  Tip of reachable chain:  ${path.basename(tip.file)}  ${pc.dim(`(id=${tip.id.slice(0, 8)}…)`)}`);
  }

  // drizzle-kit picks snapshots[length-1] after alphabetical sort as the next-diff baseline.
  // Replicate that exact selection so the user sees what drizzle-kit will actually use.
  const sortedByName = snapshots.slice().sort((a, b) => path.basename(a.file).localeCompare(path.basename(b.file)));
  const baseline = sortedByName[sortedByName.length - 1]!;
  const baselineReachable = reachableFiles.has(baseline.file);
  console.log();
  console.log(pc.bold(`drizzle-kit next-generate baseline (snapshots[length-1] after sort):`));
  console.log(`  ${path.basename(baseline.file)}  ${pc.dim(`(id=${baseline.id.slice(0, 8)}…  prevId=${baseline.prevId.slice(0, 8)}…)`)}`);
  console.log(
    `  Status: ${baselineReachable ? pc.green('✓ reachable from genesis (chain healthy up to baseline)') : pc.red('✗ NOT reachable from genesis (chain broken before baseline → next diff is built on a snapshot that is missing intermediate parents)')}`,
  );

  if (chain.issues.length > 0) {
    console.log();
    console.log(pc.bold(`Chain issues (${chain.issues.length}):`));
    for (const i of chain.issues) {
      console.log(`  - ${pc.red(i.kind)}: ${i.detail}`);
    }
  }

  // Journal ↔ snapshot mapping
  const entryPrefixes = new Set<number>();
  for (const e of journal) {
    const prefix = parseInt(e.tag.split('_')[0] ?? '', 10);
    if (!Number.isNaN(prefix)) entryPrefixes.add(prefix);
  }
  const snapshotPrefixes = new Set(snapshots.map((s) => s.filePrefix));

  const dupPrefixes = [...tagPrefixDuplicates(journal)].sort((a, b) => a[0] - b[0]);

  const entriesMissingSnap = journal.filter((e) => {
    const prefix = parseInt(e.tag.split('_')[0] ?? '', 10);
    return Number.isNaN(prefix) || !snapshotPrefixes.has(prefix);
  });
  const snapsMissingEntry = snapshots.filter((s) => !entryPrefixes.has(s.filePrefix));

  const hasMappingIssues = dupPrefixes.length > 0 || entriesMissingSnap.length > 0 || snapsMissingEntry.length > 0;
  if (hasMappingIssues) {
    console.log();
    console.log(pc.bold('Journal ↔ snapshot mapping:'));
    if (dupPrefixes.length > 0) {
      console.log(pc.red(`  Duplicate tag prefixes in journal (${dupPrefixes.length}):`));
      for (const [p, group] of dupPrefixes) {
        const padded = String(p).padStart(4, '0');
        console.log(`    - ${pc.yellow(padded)}: ${group.map((e) => `idx=${e.idx} (${e.tag})`).join(', ')}`);
      }
    }
    if (entriesMissingSnap.length > 0) {
      console.log(pc.red(`  Journal entries with no matching snapshot file (${entriesMissingSnap.length}):`));
      for (const e of entriesMissingSnap) {
        console.log(`    - idx=${String(e.idx).padStart(3)}  ${e.tag}`);
      }
    }
    if (snapsMissingEntry.length > 0) {
      console.log(pc.red(`  Snapshot files with no matching journal entry (${snapsMissingEntry.length}):`));
      for (const s of snapsMissingEntry) {
        console.log(`    - ${path.basename(s.file)}`);
      }
    }
  }

  // Drift risk: journal entries whose changes are NOT in the baseline snapshot.
  // Approximation: any journal entry whose chain-position would be > baseline's position.
  // Without a clean chain, we use the journal idx > baseline.filePrefix as a heuristic.
  const baselinePrefix = baseline.filePrefix;
  const beyondBaseline = journal.filter((e) => e.idx > baselinePrefix);
  if (beyondBaseline.length > 0) {
    console.log();
    console.log(pc.bold('Drift risk (journal entries beyond baseline):'));
    console.log(
      pc.dim(
        `  These migrations' .sql ran (or will run) against the DB, but the baseline snapshot does not capture their schema changes. Next 'drizzle-kit generate' will diff against ${path.basename(baseline.file)} and likely reintroduce these migrations as 'new', causing duplicate-creation errors at apply time.`,
      ),
    );
    for (const e of beyondBaseline) {
      console.log(`  - idx=${String(e.idx).padStart(3)}  ${e.tag}`);
    }
  }

  const ok =
    chain.issues.length === 0 &&
    dupPrefixes.length === 0 &&
    entriesMissingSnap.length === 0 &&
    snapsMissingEntry.length === 0 &&
    beyondBaseline.length === 0 &&
    baselineReachable;

  console.log();
  console.log(ok ? pc.green('✓ chain healthy') : pc.red('✗ chain unhealthy — see issues above'));
  return ok ? 0 : 1;
}
