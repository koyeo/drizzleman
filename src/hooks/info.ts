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

  // Show "major=X, patch=Y" without a misleading minor for postgres 10+
  // (server_version_num is MAJOR*10000+PATCH there, so minor is always 0 and
  // not part of the canonical release label like "18.2").
  const isPg10Plus = probe.engine === 'PostgreSQL' && probe.majorVersion >= 10;
  const numericAnnotation = isPg10Plus
    ? `major=${probe.majorVersion}, patch=${probe.patchVersion}`
    : `major=${probe.majorVersion}, minor=${probe.minorVersion}, patch=${probe.patchVersion}`;

  console.log(pc.bold('[drizzleman] target DB info:'));
  console.log(`  URL          : ${pc.cyan(renderUrl(config))}`);
  console.log(`  dialect      : ${config.dialect}`);
  console.log(`  engine       : ${pc.cyan(probe.engine)}`);
  console.log(`  version      : ${probe.versionString}`);
  console.log(`  parsed       : ${pc.cyan(probe.releaseLabel)}  ${pc.dim(`(${numericAnnotation})`)}`);
  return 0;
}
