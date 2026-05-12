import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createJiti } from 'jiti';
import type { DrizzleConfig } from './types.js';

const CANDIDATE_NAMES = [
  'drizzle.config.ts',
  'drizzle.config.mts',
  'drizzle.config.cts',
  'drizzle.config.js',
  'drizzle.config.mjs',
  'drizzle.config.cjs',
  'drizzle.config.json',
];

function findConfigFromArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--config' || a === '-c') {
      const next = args[i + 1];
      if (next) return path.resolve(process.cwd(), next);
    } else if (a.startsWith('--config=')) {
      return path.resolve(process.cwd(), a.slice('--config='.length));
    } else if (a.startsWith('-c=')) {
      return path.resolve(process.cwd(), a.slice('-c='.length));
    }
  }
  return null;
}

function findConfigInCwd(): string | null {
  for (const name of CANDIDATE_NAMES) {
    const p = path.resolve(process.cwd(), name);
    if (existsSync(p)) return p;
  }
  return null;
}

export async function loadConfig(args: string[]): Promise<DrizzleConfig> {
  const fromArgs = findConfigFromArgs(args);
  const configPath = fromArgs ?? findConfigInCwd();
  if (!configPath) {
    throw new Error(
      `drizzle config not found. Looked for: ${CANDIDATE_NAMES.join(', ')} in ${process.cwd()}`,
    );
  }
  if (!existsSync(configPath)) {
    throw new Error(`drizzle config not found at ${configPath}`);
  }

  let raw: Record<string, unknown>;
  if (configPath.endsWith('.json')) {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } else {
    const jiti = createJiti(configPath, { interopDefault: true });
    const mod = (await jiti.import(configPath)) as Record<string, unknown> & {
      default?: Record<string, unknown>;
    };
    raw = (mod.default ?? mod) as Record<string, unknown>;
  }

  return normalize(raw, configPath);
}

function normalize(raw: Record<string, unknown>, configPath: string): DrizzleConfig {
  const dialect = raw.dialect as DrizzleConfig['dialect'];
  if (!dialect) {
    throw new Error(`drizzle config at ${configPath} is missing required field 'dialect'`);
  }
  const out = (raw.out as string | undefined) ?? 'drizzle';
  const schema = raw.schema as DrizzleConfig['schema'] | undefined;
  const dbCredentials = (raw.dbCredentials as DrizzleConfig['dbCredentials']) ?? {};
  const migrations = raw.migrations as DrizzleConfig['migrations'] | undefined;
  return { dialect, out, schema, dbCredentials, migrations };
}

export function migrationsTableOf(config: DrizzleConfig): { schema?: string; table: string } {
  const table = config.migrations?.table ?? '__drizzle_migrations';
  const schema = config.dialect === 'postgresql'
    ? (config.migrations?.schema ?? 'drizzle')
    : config.migrations?.schema;
  return { schema, table };
}
