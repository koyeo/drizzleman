import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

// drizzle-kit's "no parent" marker for the first snapshot. See drizzle-kit/utils.mjs `originUUID`.
const ORIGIN_UUID = '00000000-0000-0000-0000-000000000000';

export interface SnapshotInfo {
  file: string;
  filePrefix: number;
  id: string;
  prevId: string;
}

export function readSnapshots(out: string): SnapshotInfo[] {
  const metaDir = path.resolve(process.cwd(), out, 'meta');
  if (!existsSync(metaDir)) return [];
  const files = readdirSync(metaDir).filter((f) => /^\d+_snapshot\.json$/.test(f));
  return files
    .map((f) => {
      const full = path.join(metaDir, f);
      const data = JSON.parse(readFileSync(full, 'utf8')) as { id?: string; prevId?: string };
      const rawPrev = data.prevId ?? '';
      // Normalize: drizzle-kit writes the zero UUID for "I am the genesis". Treat it as "".
      const prevId = rawPrev === ORIGIN_UUID ? '' : rawPrev;
      return {
        file: full,
        filePrefix: parseInt(f.split('_')[0]!, 10),
        id: data.id ?? '',
        prevId,
      };
    })
    .sort((a, b) => a.filePrefix - b.filePrefix);
}

export type ChainIssueKind =
  | 'missing-genesis'
  | 'multiple-genesis'
  | 'fork'
  | 'missing-parent'
  | 'duplicate-id'
  | 'cycle'
  | 'orphan';

export interface ChainIssue {
  kind: ChainIssueKind;
  detail: string;
}

export interface ChainWalk {
  order: SnapshotInfo[];
  issues: ChainIssue[];
}

export function walkChain(snapshots: SnapshotInfo[]): ChainWalk {
  const issues: ChainIssue[] = [];
  const byId = new Map<string, SnapshotInfo[]>();
  const byPrev = new Map<string, SnapshotInfo[]>();
  for (const s of snapshots) {
    let idGroup = byId.get(s.id);
    if (!idGroup) { idGroup = []; byId.set(s.id, idGroup); }
    idGroup.push(s);
    let prevGroup = byPrev.get(s.prevId);
    if (!prevGroup) { prevGroup = []; byPrev.set(s.prevId, prevGroup); }
    prevGroup.push(s);
  }

  for (const [id, group] of byId) {
    if (id !== '' && group.length > 1) {
      issues.push({
        kind: 'duplicate-id',
        detail: `id=${id} appears in ${group.length} snapshots: ${group.map((s) => path.basename(s.file)).join(', ')}`,
      });
    }
  }

  for (const s of snapshots) {
    if (s.prevId === '') continue;
    if (!byId.has(s.prevId)) {
      issues.push({
        kind: 'missing-parent',
        detail: `${path.basename(s.file)} has prevId=${s.prevId} but no snapshot has that id`,
      });
    }
  }

  const genesis = byPrev.get('') ?? [];
  if (genesis.length === 0) {
    issues.push({ kind: 'missing-genesis', detail: 'no snapshot has prevId="" — chain has no root' });
    return { order: [], issues };
  }
  if (genesis.length > 1) {
    issues.push({
      kind: 'multiple-genesis',
      detail: `${genesis.length} snapshots claim to be genesis (prevId=""): ${genesis.map((s) => path.basename(s.file)).join(', ')}`,
    });
  }

  const order: SnapshotInfo[] = [];
  const visited = new Set<string>();
  let current: SnapshotInfo | undefined = genesis[0];
  while (current) {
    if (visited.has(current.id)) {
      issues.push({ kind: 'cycle', detail: `cycle detected at ${path.basename(current.file)}` });
      break;
    }
    visited.add(current.id);
    order.push(current);
    const children: SnapshotInfo[] = byPrev.get(current.id) ?? [];
    if (children.length > 1) {
      issues.push({
        kind: 'fork',
        detail: `${path.basename(current.file)} has ${children.length} children: ${children.map((s) => path.basename(s.file)).join(', ')}`,
      });
    }
    current = children[0];
  }

  if (order.length < snapshots.length) {
    const reached = new Set(order.map((s) => s.file));
    const orphans = snapshots.filter((s) => !reached.has(s.file));
    if (orphans.length > 0) {
      issues.push({
        kind: 'orphan',
        detail: `${orphans.length} snapshot(s) unreachable from genesis: ${orphans.map((s) => path.basename(s.file)).join(', ')}`,
      });
    }
  }

  return { order, issues };
}
