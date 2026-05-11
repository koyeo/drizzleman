import path from 'node:path';
import type { DrizzleConfig } from './types.js';

export function targetUrl(config: DrizzleConfig): string {
  const { dialect, dbCredentials } = config;

  if (dialect === 'sqlite') {
    const file = typeof dbCredentials.url === 'string' && dbCredentials.url
      ? dbCredentials.url
      : '<no file>';
    return path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  }

  if (typeof dbCredentials.url === 'string' && dbCredentials.url.length > 0) {
    return stripPassword(dbCredentials.url);
  }

  const host = (dbCredentials.host as string | undefined) ?? 'localhost';
  const port = dbCredentials.port as number | undefined;
  const user = dbCredentials.user as string | undefined;
  const database = (dbCredentials.database as string | undefined) ?? '';
  const userPart = user ? `${user}@` : '';
  const portPart = port ? `:${port}` : '';
  return `${dialect}://${userPart}${host}${portPart}/${database}`;
}

function stripPassword(url: string): string {
  try {
    const u = new URL(url);
    const userPart = u.username ? `${decodeURIComponent(u.username)}@` : '';
    const protocol = u.protocol;
    const host = u.host;
    const path_ = u.pathname || '/';
    const query = u.search || '';
    return `${protocol}//${userPart}${host}${path_}${query}`;
  } catch {
    return url.replace(/:\/\/([^:@/]+):([^@/]+)@/, '://$1@');
  }
}
