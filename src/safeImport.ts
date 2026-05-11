// Optional-dependency dynamic import that bypasses TypeScript's module
// resolution check. The drivers (pg / mysql2 / better-sqlite3) are declared
// as optionalDependencies and may not be installed in every user environment.
const dynImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;

export async function safeImport<T = unknown>(name: string, installHint: string): Promise<T> {
  try {
    return (await dynImport(name)) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`DB driver '${name}' not available (${msg}). Install it: ${installHint}`);
  }
}
