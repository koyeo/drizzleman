import type { AppliedRow, DiffResult, JournalEntry } from '../types.js';

export function diff(local: JournalEntry[], applied: AppliedRow[]): DiffResult {
  const result: DiffResult = {
    applied: [],
    pending: [],
    drifted: [],
    dbExtra: [],
    localCount: local.length,
    dbCount: applied.length,
  };
  const len = Math.max(local.length, applied.length);
  for (let i = 0; i < len; i++) {
    const e = local[i];
    const a = applied[i];
    if (e && a) {
      if (e.hash === a.hash) result.applied.push(e);
      else result.drifted.push({ entry: e, dbHash: a.hash });
    } else if (e) {
      result.pending.push(e);
    } else if (a) {
      result.dbExtra.push(a);
    }
  }
  return result;
}
