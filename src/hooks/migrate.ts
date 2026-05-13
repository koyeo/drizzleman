import { statSync } from 'node:fs';
import readline from 'node:readline';
import pc from 'picocolors';
import { migrationsTableOf } from '../config.js';
import { appendAppliedHash, readApplied } from '../db/index.js';
import { passthrough } from '../passthrough.js';
import { readJournal } from '../journal.js';
import { diff } from './diff.js';
import { preTarget } from './preTarget.js';

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

async function confirm(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(
      pc.red(`[drizzleman] non-TTY environment; pass --yes / -y to skip the interactive confirmation.`),
    );
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(pc.bold('Proceed? [Y/n] '), (ans) => {
      rl.close();
      const t = ans.trim().toLowerCase();
      resolve(t === '' || t === 'y' || t === 'yes');
    });
  });
}

export async function runMigrate(args: string[], yes: boolean): Promise<number> {
  const config = await preTarget(args);
  const journal = readJournal(config.out);
  const table = migrationsTableOf(config);
  const applied = await readApplied(config.dialect, config.dbCredentials, table);
  const d = diff(journal, applied);

  if (d.drifted.length > 0) {
    console.log(pc.red(`[drizzleman] ✗ ${d.drifted.length} migration(s) drifted; refusing to migrate.`));
    for (const x of d.drifted) console.log(`  - ${x.entry.tag} (local hash != db hash)`);
    return 1;
  }

  if (d.dbExtra.length > 0) {
    console.log(
      pc.yellow(
        `[drizzleman] ! DB has ${d.dbExtra.length} migration(s) not present locally — local journal is behind. drizzle-kit will only apply local pending migrations, but you should pull/sync.`,
      ),
    );
  }

  if (d.pending.length === 0) {
    console.log(pc.green(`[drizzleman] ✓ Already up to date (db=${d.dbCount}). Skipping drizzle-kit.`));
    return 0;
  }

  // Partition pending into "manual" (drizzleman-generated diff.sql etc. that
  // MUST NOT be executed by the tool — see CLAUDE.md G2/G6) vs "auto"
  // (regular drizzle-kit migrations to be applied by drizzle-kit migrate).
  const pendingManual = d.pending.filter((e) => e.manual === true);
  const pendingAuto = d.pending.filter((e) => e.manual !== true);

  console.log(pc.bold(`[drizzleman] Pending migrations (${d.pending.length}):`));
  for (const e of d.pending) {
    let size = '?';
    try { size = formatBytes(statSync(e.sqlPath).size); } catch { /* ignore */ }
    const flag = e.manual ? pc.red(' MANUAL') : '';
    console.log(`  - ${pc.cyan(String(e.idx).padStart(4, '0'))}  ${e.tag.padEnd(40)} ${pc.dim(size)}${flag}`);
  }
  if (pendingManual.length > 0) {
    console.log('');
    console.log(
      pc.red(
        `  ⚠ ${pendingManual.length} entry(ies) flagged \`manual: true\` — drizzleman will register their ` +
          `hash into ${table.schema ? `${table.schema}.` : ''}${table.table} ONLY; it will NOT execute the SQL ` +
          `against target.`,
      ),
    );
    console.log(
      pc.dim(
        `  Per CLAUDE.md G2/G6: you must run those files yourself, e.g. ` +
          `\`psql <target> -f ${pendingManual[0]!.sqlPath}\`, BEFORE registering.`,
      ),
    );
  }

  if (!yes) {
    const ok = await confirm();
    if (!ok) {
      console.log(pc.dim('[drizzleman] aborted.'));
      return 130;
    }
  }

  // Auto entries: forward to drizzle-kit migrate (which will see ALL journal
  // entries — including manual ones — but only the pending non-manual ones
  // matter for drizzle-kit's logic. We register manual hashes BEFORE
  // calling drizzle-kit so drizzle-kit treats them as already applied and
  // doesn't try to run them.
  for (const e of pendingManual) {
    try {
      const r = await appendAppliedHash(config.dialect, config.dbCredentials, table, {
        hash: e.hash,
        createdAt: Date.now(),
      });
      if (r.inserted) {
        console.log(
          pc.green(`  ✓ registered ${e.tag} hash (manual; SQL NOT executed by drizzleman)`),
        );
      } else {
        console.log(pc.dim(`  · ${e.tag} hash already present — skipped`));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(pc.red(`  ✗ failed to register ${e.tag} hash: ${msg}`));
      return 1;
    }
  }

  if (pendingAuto.length === 0) {
    console.log(pc.green('[drizzleman] ✓ all pending entries were manual; nothing to forward to drizzle-kit.'));
    return 0;
  }

  const code = await passthrough(args);
  if (code !== 0) {
    console.log(pc.red(`[drizzleman] drizzle-kit exited with code ${code}; skipping post-check.`));
    return code;
  }

  const applied2 = await readApplied(config.dialect, config.dbCredentials, table);
  const d2 = diff(journal, applied2);
  if (d2.drifted.length > 0 || d2.pending.length > 0) {
    console.log(
      pc.red(
        `[drizzleman] ✗ Post-check FAILED: applied=${d2.applied.length}, pending=${d2.pending.length}, drifted=${d2.drifted.length}`,
      ),
    );
    for (const e of d2.pending) console.log(`  pending: ${e.tag}`);
    for (const x of d2.drifted) console.log(`  drifted: ${x.entry.tag}`);
    return 1;
  }
  console.log(
    pc.green(`[drizzleman] ✓ Applied ${d2.applied.length} / pending 0 / drifted 0.`),
  );
  return 0;
}
