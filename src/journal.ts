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

export interface JournalIdxIssues {
  missing: number[];
  duplicate: number[];
  outOfRange: number[];
}

export function idxIssues(entries: JournalEntry[]): JournalIdxIssues {
  const expected = entries.length;
  const counts = new Map<number, number>();
  for (const e of entries) counts.set(e.idx, (counts.get(e.idx) ?? 0) + 1);

  const missing: number[] = [];
  for (let i = 0; i < expected; i++) {
    if (!counts.has(i)) missing.push(i);
  }
  const duplicate: number[] = [];
  const outOfRange: number[] = [];
  for (const [idx, n] of counts) {
    if (n > 1) duplicate.push(idx);
    if (idx < 0 || idx >= expected) outOfRange.push(idx);
  }
  duplicate.sort((a, b) => a - b);
  outOfRange.sort((a, b) => a - b);
  return { missing, duplicate, outOfRange };
}

export function hasIdxIssues(issues: JournalIdxIssues): boolean {
  return issues.missing.length > 0 || issues.duplicate.length > 0 || issues.outOfRange.length > 0;
}

export function tagPrefixDuplicates(entries: JournalEntry[]): Map<number, JournalEntry[]> {
  const byPrefix = new Map<number, JournalEntry[]>();
  for (const e of entries) {
    const prefix = parseInt(e.tag.split('_')[0] ?? '', 10);
    if (Number.isNaN(prefix)) continue;
    let group = byPrefix.get(prefix);
    if (!group) { group = []; byPrefix.set(prefix, group); }
    group.push(e);
  }
  const dups = new Map<number, JournalEntry[]>();
  for (const [p, group] of byPrefix) {
    if (group.length > 1) dups.set(p, group);
  }
  return dups;
}

export function formatIdxIssues(issues: JournalIdxIssues): string {
  const parts: string[] = [];
  if (issues.missing.length > 0) parts.push(`missing=[${issues.missing.join(', ')}]`);
  if (issues.duplicate.length > 0) parts.push(`duplicate=[${issues.duplicate.join(', ')}]`);
  if (issues.outOfRange.length > 0) parts.push(`out-of-range=[${issues.outOfRange.join(', ')}]`);
  return parts.join('  ');
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
