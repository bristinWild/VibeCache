import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type {
  ProtectedPathSnapshot,
  RepositoryIntegrityPort,
} from '../../core/ports/repository-integrity.port';

const PROTECTED_ROOTS = ['.cliper', '.vibe'] as const;

export class FilesystemRepositoryIntegrityAdapter implements RepositoryIntegrityPort {
  async snapshotProtectedPaths(
    repositoryPath: string,
  ): Promise<ProtectedPathSnapshot> {
    const root = await realpath(resolve(repositoryPath));
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) {
      throw new TypeError(`Repository path is not a directory: ${root}.`);
    }

    const hash = createHash('sha256');
    let entryCount = 0;
    for (const protectedRoot of PROTECTED_ROOTS) {
      const absolutePath = join(root, protectedRoot);
      const pathStat = await lstatIfExists(absolutePath);
      if (!pathStat) {
        update(hash, protectedRoot, 'missing');
        continue;
      }
      if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
        throw new Error(
          `Protected repository path must be a real directory: ${absolutePath}.`,
        );
      }
      entryCount += await digestEntry(root, absolutePath, hash);
    }

    return { algorithm: 'sha256', digest: hash.digest('hex'), entryCount };
  }
}

async function digestEntry(
  root: string,
  absolutePath: string,
  hash: ReturnType<typeof createHash>,
): Promise<number> {
  const pathStat = await lstat(absolutePath);
  const repositoryPath = normalizeRelativePath(root, absolutePath);

  if (pathStat.isSymbolicLink()) {
    update(hash, repositoryPath, 'symlink', await readlink(absolutePath));
    return 1;
  }
  if (pathStat.isDirectory()) {
    update(hash, repositoryPath, 'directory');
    const entries = await readdir(absolutePath);
    entries.sort((left, right) => left.localeCompare(right));
    let count = 1;
    for (const entry of entries) {
      count += await digestEntry(root, join(absolutePath, entry), hash);
    }
    return count;
  }
  if (pathStat.isFile()) {
    const fileHash = createHash('sha256');
    for await (const chunk of createReadStream(absolutePath)) {
      fileHash.update(chunk as Buffer);
    }
    update(hash, repositoryPath, 'file', fileHash.digest('hex'));
    return 1;
  }

  throw new Error(`Unsupported entry under protected path: ${absolutePath}.`);
}

function normalizeRelativePath(root: string, absolutePath: string): string {
  const path = relative(root, absolutePath);
  if (!path || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(
      `Protected path escaped the repository root: ${absolutePath}.`,
    );
  }
  return path.split(sep).join('/');
}

function update(
  hash: ReturnType<typeof createHash>,
  ...values: Array<string | Buffer>
): void {
  for (const value of values) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    hash.update(String(bytes.length));
    hash.update(':');
    hash.update(bytes);
    hash.update(';');
  }
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') return null;
    throw error;
  }
}
