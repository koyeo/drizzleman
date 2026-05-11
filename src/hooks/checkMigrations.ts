import pc from 'picocolors';
import { migrationsTableOf } from '../config.js';
import { readApplied } from '../db/index.js';
import { idxTagMismatches, readJournal } from '../journal.js';
import type { AppliedRow, JournalEntry } from '../types.js';
import { renderTable } from '../ui/table.js';
import { preTarget } from './preTarget.js';

type Status = 'applied' | 'pending' | 'drifted' | 'extra' | 'zombie';

interface Row {
  idx: string;
  tag: string;
  journalWhen: string;
  dbCreatedAt: string;
  status: Status;
}

const STATUS_COLOR: Record<Status, (s: string) => string> = {
  applied: pc.green,
  pending: pc.yellow,
  drifted: pc.red,
  extra: pc.magenta,
  zombie: pc.red,
};

function formatWhen(ts: number | undefined): string {
  if (!ts) return '-';
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function buildRows(local: JournalEntry[], applied: AppliedRow[], tLast: number): Row[] {
  const rows: Row[] = [];
  const len = Math.max(local.length, applied.length);
  for (let i = 0; i < len; i++) {
    const e = local[i];
    const a = applied[i];
    if (e && a) {
      const status: Status = e.hash === a.hash ? 'applied' : 'drifted';
      rows.push({
        idx: String(e.idx).padStart(4, '0'),
        tag: e.tag,
        journalWhen: formatWhen(e.when),
        dbCreatedAt: formatWhen(a.createdAt),
        status,
      });
    } else if (e) {
      // pending vs zombie: drizzle-orm only applies entries with when > T_last.
      // If a local entry has when <= T_last but no matching DB row, drizzle-orm
      // will silently skip it forever.
      const status: Status = e.when <= tLast ? 'zombie' : 'pending';
      rows.push({
        idx: String(e.idx).padStart(4, '0'),
        tag: e.tag,
        journalWhen: formatWhen(e.when),
        dbCreatedAt: '-',
        status,
      });
    } else if (a) {
      rows.push({
        idx: '-',
        tag: `<db-extra: ${a.hash.slice(0, 12)}…>`,
        journalWhen: '-',
        dbCreatedAt: formatWhen(a.createdAt),
        status: 'extra',
      });
    }
  }
  return rows;
}

function findNonMonotonicWhen(local: JournalEntry[]): JournalEntry[] {
  const out: JournalEntry[] = [];
  let prev = -Infinity;
  for (const e of local) {
    if (e.when < prev) out.push(e);
    if (e.when > prev) prev = e.when;
  }
  return out;
}

export async function runCheckMigrations(args: string[]): Promise<number> {
  const config = await preTarget(args);
  const journal = readJournal(config.out);
  const applied = await readApplied(config.dialect, config.dbCredentials, migrationsTableOf(config));

  const tLast = applied.reduce((m, r) => Math.max(m, r.createdAt), 0);

  console.log(
    `Local entries: ${journal.length}    DB rows: ${applied.length}    ` +
      `T_last (max created_at): ${pc.cyan(tLast ? formatWhen(tLast) : '-')} ${pc.dim(`(${tLast})`)}`,
  );

  const rows = buildRows(journal, applied, tLast);

  if (rows.length === 0) {
    console.log(pc.dim('(no migrations)'));
    console.log(pc.green('✓ aligned'));
    return 0;
  }

  const headers = ['idx', 'tag', 'journal.when', 'DB.created_at', 'status'];
  const tableRows = rows.map((r) => [
    r.idx,
    r.tag,
    r.journalWhen,
    r.dbCreatedAt,
    STATUS_COLOR[r.status](r.status),
  ]);
  console.log(renderTable(headers, tableRows));

  const counts = {
    applied: rows.filter((r) => r.status === 'applied').length,
    pending: rows.filter((r) => r.status === 'pending').length,
    drifted: rows.filter((r) => r.status === 'drifted').length,
    extra: rows.filter((r) => r.status === 'extra').length,
    zombie: rows.filter((r) => r.status === 'zombie').length,
  };
  console.log(
    `Summary: local=${journal.length}  db=${applied.length}  ` +
      `${pc.green(`applied=${counts.applied}`)}  ` +
      `${pc.yellow(`pending=${counts.pending}`)}  ` +
      `${pc.red(`drifted=${counts.drifted}`)}  ` +
      `${pc.magenta(`extra=${counts.extra}`)}  ` +
      `${pc.red(`zombie=${counts.zombie}`)}`,
  );

  const tagMismatches = idxTagMismatches(journal);
  if (tagMismatches.length > 0) {
    console.log(
      pc.red(`Journal idx ≠ tag prefix: ${tagMismatches.length} entr${tagMismatches.length === 1 ? 'y' : 'ies'}`),
    );
    for (const m of tagMismatches) {
      console.log(
        `  - idx=${pc.yellow(String(m.idx).padStart(4, '0'))}  tag=${pc.cyan(m.tag)}  ${pc.dim(`(prefix ${String(m.tagPrefix).padStart(4, '0')})`)}`,
      );
    }
  }

  const nonMonotonic = findNonMonotonicWhen(journal);
  if (nonMonotonic.length > 0) {
    console.log(
      pc.red(`journal.when not monotonic with idx: ${nonMonotonic.length} entr${nonMonotonic.length === 1 ? 'y' : 'ies'} go backwards in time.`),
    );
    console.log(
      pc.dim(`  drizzle-orm applies entries by 'when > T_last' check, so non-monotonic 'when' can produce zombie entries (silently skipped at migrate).`),
    );
    for (const e of nonMonotonic) {
      console.log(
        `  - idx=${pc.yellow(String(e.idx).padStart(4, '0'))}  tag=${pc.cyan(e.tag)}  when=${formatWhen(e.when)}`,
      );
    }
  }

  if (counts.zombie > 0) {
    console.log(
      pc.red(
        `Zombie entries (${counts.zombie}): local hash not in DB and when <= T_last → drizzle-orm will NEVER apply these.`,
      ),
    );
  }

  const ok =
    counts.pending === 0 &&
    counts.drifted === 0 &&
    counts.extra === 0 &&
    counts.zombie === 0 &&
    tagMismatches.length === 0 &&
    nonMonotonic.length === 0;
  console.log(ok ? pc.green('✓ aligned') : pc.red('✗ not aligned'));
  return ok ? 0 : 1;
}
