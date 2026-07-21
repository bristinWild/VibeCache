import { createRequire } from 'node:module';

const loadPackage = createRequire(__filename);

const packageJson = loadPackage('../package.json') as { version?: unknown };

export const VIBECACHE_VERSION =
  typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
