import pc from 'picocolors';
import { migrationsTableOf } from '../config.js';
import { readApplied } from '../db/index.js';
import { passthrough } from '../passthrough.js';
import { formatIdxIssues, hasIdxIssues, idxIssues, idxTagMismatches, readJournal } from '../journal.js';
import { diff } from './diff.js';
import { preTarget } from './preTarget.js';

export async function runGenerate(args: string[]): Promise<number> {
  const config = await preTarget(args);
  const journal = readJournal(config.out);

  const idxState = idxIssues(journal);
  if (hasIdxIssues(idxState)) {
    console.log(pc.red(`[drizzleman] ✗ Journal idx not contiguous: ${formatIdxIssues(idxState)}`));
    console.log(
      pc.dim(
        `  drizzle-kit assigns next idx = entries.length (${journal.length}), which will collide with gaps/duplicates above. Reconcile journal so set(idx) == {0..${journal.length - 1}} before generating.`,
      ),
    );
    return 1;
  }

  const mismatches = idxTagMismatches(journal);
  if (mismatches.length > 0) {
    console.log(
      pc.red(
        `[drizzleman] ✗ Journal corruption: ${mismatches.length} entr${mismatches.length === 1 ? 'y' : 'ies'} where journal idx ≠ tag prefix.`,
      ),
    );
    for (const m of mismatches) {
      console.log(
        `  - idx=${pc.yellow(String(m.idx).padStart(4, '0'))}  tag=${pc.cyan(m.tag)}  ${pc.dim(`(tag prefix ${String(m.tagPrefix).padStart(4, '0')})`)}`,
      );
    }
    console.log(
      pc.dim(
        `  drizzle-kit would generate the next file with prefix ${String(journal.length).padStart(4, '0')} based on journal length, which may collide visually with existing tags. Reconcile the journal (renumber / reorder entries so idx == tag prefix) before generating.`,
      ),
    );
    return 1;
  }

  const applied = await readApplied(config.dialect, config.dbCredentials, migrationsTableOf(config));
  const d = diff(journal, applied);

  if (d.drifted.length > 0) {
    console.log(pc.red(`[drizzleman] ✗ ${d.drifted.length} migration(s) drifted; refusing to generate.`));
    for (const x of d.drifted) {
      console.log(`  - ${x.entry.tag} (local hash != db hash)`);
    }
    return 1;
  }

  if (d.localCount > d.dbCount) {
    console.log(
      pc.red(
        `[drizzleman] ✗ Local journal ahead of DB by ${d.localCount - d.dbCount} migration(s). Run 'drizzleman migrate' first, then generate.`,
      ),
    );
    for (const e of d.pending) console.log(`  - ${e.tag}`);
    return 1;
  }

  if (d.localCount < d.dbCount) {
    console.log(
      pc.red(
        `[drizzleman] ✗ DB has ${d.dbCount - d.localCount} migration(s) not present locally (db=${d.dbCount}, local=${d.localCount}). Pull/sync the missing migration files first.`,
      ),
    );
    return 1;
  }

  console.log(
    pc.dim(`[drizzleman] Aligned: local=${d.localCount} / db=${d.dbCount}. Next migration index = ${d.localCount}.`),
  );
  return passthrough(args);
}
