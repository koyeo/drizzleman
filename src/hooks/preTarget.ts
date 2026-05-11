import pc from 'picocolors';
import { loadConfig } from '../config.js';
import { targetUrl } from '../url.js';
import type { DrizzleConfig } from '../types.js';

export async function preTarget(args: string[]): Promise<DrizzleConfig> {
  const config = await loadConfig(args);
  const url = targetUrl(config);
  console.log(`${pc.dim('[drizzlex]')} Target: ${pc.cyan(url)}`);
  return config;
}
