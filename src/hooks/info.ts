import pc from 'picocolors';
import { probeDb } from '../db/probe.js';
import { targetUrl as renderUrl } from '../url.js';
import { preTarget } from './preTarget.js';

export async function runInfo(args: string[]): Promise<number> {
  // Drop the leading 'info' command word so it isn't forwarded as an
  // unknown drizzle-kit option.
  const rest = args[0] === 'info' ? args.slice(1) : args;
  const config = await preTarget(rest);

  let probe;
  try {
    probe = await probeDb(config.dialect, config.dbCredentials);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(pc.red(`[drizzleman] ✗ failed to probe ${config.dialect} target: ${msg}`));
    return 1;
  }

  console.log(pc.bold('[drizzleman] target DB info:'));
  console.log(`  URL          : ${pc.cyan(renderUrl(config))}`);
  console.log(`  dialect      : ${config.dialect}`);
  console.log(`  engine       : ${pc.cyan(probe.engine)}`);
  console.log(`  version      : ${probe.versionString}`);
  console.log(
    `  parsed       : ${pc.cyan(`${probe.majorVersion}.${probe.minorVersion}.${probe.patchVersion}`)}` +
      `  ${pc.dim(`(major=${probe.majorVersion}, minor=${probe.minorVersion}, patch=${probe.patchVersion})`)}`,
  );
  return 0;
}
