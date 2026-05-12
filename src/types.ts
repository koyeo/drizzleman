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
