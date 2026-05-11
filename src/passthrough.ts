import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function resolveDrizzleKitBin(): string | null {
  // drizzle-kit's `exports` field forbids subpath imports (bin.cjs, package.json).
  // Resolve the main entry to get *some* file inside the package, then walk up to
  // find the package.json so we can read its `bin` field.
  const requireFromCwd = createRequire(pathToFileURL(process.cwd() + '/').href);
  let mainFile: string;
  try {
    mainFile = requireFromCwd.resolve('drizzle-kit');
  } catch {
    return null;
  }
  let dir = path.dirname(mainFile);
  while (dir !== path.dirname(dir)) {
    const pjPath = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pjPath, 'utf8')) as {
        name?: string;
        bin?: string | Record<string, string>;
      };
      if (pkg.name === 'drizzle-kit') {
        const binEntry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['drizzle-kit'];
        if (!binEntry) return null;
        return path.resolve(dir, binEntry);
      }
    } catch {
      // not this dir, keep walking
    }
    dir = path.dirname(dir);
  }
  return null;
}

export function passthrough(args: string[]): Promise<number> {
  const resolved = resolveDrizzleKitBin();
  // Spawn via `node <bin>` if we resolved a file path; else fall back to PATH lookup.
  const isFile = resolved !== null;
  const cmd = isFile ? process.execPath : 'drizzle-kit';
  const cmdArgs = isFile ? [resolved!, ...args] : args;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: 'inherit' });

    const forward = (sig: NodeJS.Signals) => {
      if (!child.killed) child.kill(sig);
    };
    const onSigint = () => forward('SIGINT');
    const onSigterm = () => forward('SIGTERM');
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    child.on('error', (err) => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      reject(new Error(`failed to spawn drizzle-kit: ${err.message}`));
    });

    child.on('exit', (code, signal) => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      if (signal) {
        // Re-raise the signal on ourselves so the parent shell sees the right exit reason.
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
