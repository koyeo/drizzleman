export type Dialect = 'postgresql' | 'mysql' | 'sqlite';

export interface DbCredentials {
  url?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  // sqlite uses `url` as filename. ssl / other fields are ignored for URL display.
  [key: string]: unknown;
}

export interface DrizzleConfig {
  dialect: Dialect;
  out: string;
  schema?: string | string[];
  dbCredentials: DbCredentials;
  migrations?: {
    table?: string;
    schema?: string;
  };
}

export interface MigrationsTableRef {
  schema?: string;
  table: string;
}

export interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
  sqlPath: string;
  hash: string;
  // `manual: true` (drizzleman-only journal field, ignored by drizzle-kit) marks
  // entries whose SQL must NEVER be auto-executed against target DB — only the
  // hash gets registered into the migrations table after the user manually
  // runs the SQL elsewhere (e.g. `psql target -f 0001_diff.sql`). See
  // drizzleman/CLAUDE.md G2 and SkAI/CLAUDE.md G6.
  manual?: boolean;
}

export interface AppliedRow {
  hash: string;
  createdAt: number;
}

export interface DiffResult {
  applied: JournalEntry[];
  pending: JournalEntry[];
  drifted: { entry: JournalEntry; dbHash: string }[];
  dbExtra: AppliedRow[];
  localCount: number;
  dbCount: number;
}
