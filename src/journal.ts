import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { JournalEntry } from './types.js';

interface RawJournalEntry {
  idx: number;
  version?: string;
  when: number;
  tag: string;
  breakpoints?: boolean;
}

interface RawJournal {
  version: string;
  dialect: string;
  entries: RawJournalEntry[];
}

function journalPathOf(out: string): string {
  return path.resolve(process.cwd(), out, 'meta/_journal.json');
}

export function journalExists(out: string): boolean {
  return existsSync(journalPathOf(out));
}

export interface IdxTagMismatch {
  idx: number;
  tag: string;
  tagPrefix: number;
}

export function idxTagMismatches(entries: JournalEntry[]): IdxTagMismatch[] {
  const out: IdxTagMismatch[] = [];
  for (const e of entries) {
    const prefix = parseInt(e.tag.split('_')[0] ?? '', 10);
    if (Number.isNaN(prefix)) continue;
    if (prefix !== e.idx) out.push({ idx: e.idx, tag: e.tag, tagPrefix: prefix });
  }
  return out;
}

export function readJournal(out: string): JournalEntry[] {
  const journalPath = journalPathOf(out);
  if (!existsSync(journalPath)) return [];
  const raw = JSON.parse(readFileSync(journalPath, 'utf8')) as RawJournal;
  return raw.entries
    .slice()
    .sort((a, b) => a.idx - b.idx)
    .map((e) => {
      const sqlPath = path.resolve(process.cwd(), out, `${e.tag}.sql`);
      const sql = readFileSync(sqlPath, 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      return { idx: e.idx, tag: e.tag, when: e.when, sqlPath, hash };
    });
}
