import { runAlign } from './align.js';
import { runCheckChain } from './checkChain.js';
import { runCheckMigrations } from './checkMigrations.js';
import { runGenerate } from './generate.js';
import { runInfo } from './info.js';
import { runMigrate } from './migrate.js';
import { runPush } from './push.js';
import { runRebase } from './rebase.js';
import { runRenumber } from './renumber.js';

function consumeYesFlag(args: string[]): { yes: boolean; rest: string[] } {
  let yes = false;
  const rest: string[] = [];
  for (const a of args) {
    if (a === '--yes' || a === '-y') {
      yes = true;
      continue;
    }
    rest.push(a);
  }
  return { yes, rest };
}

export async function runHook(cmd: string, args: string[]): Promise<number> {
  switch (cmd) {
    case 'generate':
      return runGenerate(args);
    case 'migrate': {
      const { yes, rest } = consumeYesFlag(args);
      return runMigrate(rest, yes);
    }
    case 'push':
      return runPush(args);
    case 'check-migrations':
      return runCheckMigrations(args);
    case 'check-chain':
      return runCheckChain(args);
    case 'align':
      return runAlign(args);
    case 'renumber':
      return runRenumber(args);
    case 'rebase':
      return runRebase(args);
    case 'info':
      return runInfo(args);
    default:
      throw new Error(`unknown hook command: ${cmd}`);
  }
}
