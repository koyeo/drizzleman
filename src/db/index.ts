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

export async function assertSchemaDbEmpty(
  dialect: Dialect,
  creds: DbCredentials,
): Promise<void> {
  switch (dialect) {
    case 'postgresql': {
      const { assertSchemaDbEmpty } = await import('./pg.js');
      return assertSchemaDbEmpty(creds);
    }
    case 'mysql': {
      const { assertSchemaDbEmpty } = await import('./mysql.js');
      return assertSchemaDbEmpty(creds);
    }
    case 'sqlite': {
      const { assertSchemaDbEmpty } = await import('./sqlite.js');
      return assertSchemaDbEmpty(creds);
    }
    default: {
      const _exhaustive: never = dialect;
      throw new Error(`unsupported dialect: ${String(_exhaustive)}`);
    }
  }
}

export async function resetAppliedToBaseline(
  dialect: Dialect,
  creds: DbCredentials,
  table: MigrationsTableRef,
  baseline: { hash: string; createdAt: number },
  backupTable: string | null,
): Promise<void> {
  switch (dialect) {
    case 'postgresql': {
      const { resetAppliedToBaseline } = await import('./pg.js');
      return resetAppliedToBaseline(creds, table, baseline, backupTable);
    }
    case 'mysql': {
      const { resetAppliedToBaseline } = await import('./mysql.js');
      return resetAppliedToBaseline(creds, table, baseline, backupTable);
    }
    case 'sqlite': {
      const { resetAppliedToBaseline } = await import('./sqlite.js');
      return resetAppliedToBaseline(creds, table, baseline, backupTable);
    }
    default: {
      const _exhaustive: never = dialect;
      throw new Error(`unsupported dialect: ${String(_exhaustive)}`);
    }
  }
}
