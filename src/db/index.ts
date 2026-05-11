import type { AppliedRow, DbCredentials, Dialect, MigrationsTableRef } from '../types.js';

export async function readApplied(
  dialect: Dialect,
  creds: DbCredentials,
  table: MigrationsTableRef,
): Promise<AppliedRow[]> {
  switch (dialect) {
    case 'postgresql': {
      const { readApplied } = await import('./pg.js');
      return readApplied(creds, table);
    }
    case 'mysql': {
      const { readApplied } = await import('./mysql.js');
      return readApplied(creds, table);
    }
    case 'sqlite': {
      const { readApplied } = await import('./sqlite.js');
      return readApplied(creds, table);
    }
    default: {
      const _exhaustive: never = dialect;
      throw new Error(`unsupported dialect: ${String(_exhaustive)}`);
    }
  }
}
