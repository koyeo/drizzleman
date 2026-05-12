#!/usr/bin/env node
import { passthrough } from './passthrough.js';
import { runHook } from './hooks/index.js';

const HOOK_COMMANDS = new Set(['generate', 'migrate', 'push', 'check-migrations', 'check-chain', 'align', 'renumber', 'baseline']);

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd && HOOK_COMMANDS.has(cmd)) {
    return runHook(cmd, args);
  }

  return passthrough(args);
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[drizzleman] ${msg}`);
    process.exit(1);
  });
