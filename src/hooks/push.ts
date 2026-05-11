import { passthrough } from '../passthrough.js';
import { preTarget } from './preTarget.js';

export async function runPush(args: string[]): Promise<number> {
  await preTarget(args);
  return passthrough(args);
}
