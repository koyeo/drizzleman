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

// Append a single hash row into the migrations table without touching the
// rest. Used by `drizzleman migrate` to register hashes for `manual: true`
// journal entries (whose SQL the user runs by hand against target — see
// CLAUDE.md G2/G6). Idempotent: skips if the same hash is already present.
export async function appendAppliedHash(
  dialect: Dialect,
  creds: DbCredentials,
  table: MigrationsTableRef,
  entry: { hash: string; createdAt: number },
): Promise<{ inserted: boolean }> {
  switch (dialect) {
    case 'postgresql': {
      const { appendAppliedHash } = await import('./pg.js');
      return appendAppliedHash(creds, table, entry);
    }
    case 'mysql': {
      const { appendAppliedHash } = await import('./mysql.js');
      return appendAppliedHash(creds, table, entry);
    }
    case 'sqlite': {
      const { appendAppliedHash } = await import('./sqlite.js');
      return appendAppliedHash(creds, table, entry);
    }
    default: {
      const _exhaustive: never = dialect;
      throw new Error(`unsupported dialect: ${String(_exhaustive)}`);
    }
  }
}

export async function resetAppliedToRebase(
  dialect: Dialect,
  creds: DbCredentials,
  table: MigrationsTableRef,
  rebase: { hash: string; createdAt: number },
  backupTable: string | null,
): Promise<void> {
  switch (dialect) {
    case 'postgresql': {
      const { resetAppliedToRebase } = await import('./pg.js');
      return resetAppliedToRebase(creds, table, rebase, backupTable);
    }
    case 'mysql': {
      const { resetAppliedToRebase } = await import('./mysql.js');
      return resetAppliedToRebase(creds, table, rebase, backupTable);
    }
    case 'sqlite': {
      const { resetAppliedToRebase } = await import('./sqlite.js');
      return resetAppliedToRebase(creds, table, rebase, backupTable);
    }
    default: {
      const _exhaustive: never = dialect;
      throw new Error(`unsupported dialect: ${String(_exhaustive)}`);
    }
  }
}
