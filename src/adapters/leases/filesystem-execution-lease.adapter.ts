import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { hostname as systemHostname } from 'node:os';
import { join, resolve } from 'node:path';
import {
  EXECUTION_LEASE_SCHEMA_VERSION,
  type ExecutionLease,
  type ExecutionLeaseOwner,
  type ExecutionLeasePort,
} from '../../core/ports/execution-lease.port';
import {
  ExecutionLeaseBusyError,
  ExecutionLeaseOwnershipError,
  ExecutionLeaseStateError,
} from './execution-lease.errors';

const LEASE_FILE_NAME = 'execution.lock';
const MAX_ACQUIRE_ATTEMPTS = 8;
const MAX_LEASE_RECORD_BYTES = 8 * 1024;
const SAFE_FEATURE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MAX_FEATURE_ID_LENGTH = 128;
const TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface FilesystemExecutionLeaseOptions {
  pid?: number;
  hostname?: string;
  now?: () => Date;
  tokenFactory?: () => string;
  isProcessAlive?: (pid: number) => boolean;
}

interface LeasePaths {
  root: string;
  vibeDirectory: string;
  locksDirectory: string;
  leasePath: string;
}

type ReclaimResult = 'reclaimed' | 'retry';

/**
 * A conservative, repository-wide execution lease backed by one atomic file.
 * The feature id is owner metadata; it is intentionally not part of the path,
 * because different features must not edit one repository concurrently.
 */
export class FilesystemExecutionLeaseAdapter implements ExecutionLeasePort {
  private readonly pid: number;
  private readonly hostname: string;
  private readonly now: () => Date;
  private readonly tokenFactory: () => string;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(options: FilesystemExecutionLeaseOptions = {}) {
    this.pid = validPid(options.pid ?? process.pid, 'pid');
    this.hostname = nonEmpty(options.hostname ?? systemHostname(), 'hostname');
    this.now = options.now ?? (() => new Date());
    this.tokenFactory = options.tokenFactory ?? randomUUID;
    this.isProcessAlive = options.isProcessAlive ?? localProcessIsAlive;
  }

  async acquire(
    repositoryPath: string,
    featureId: string,
  ): Promise<ExecutionLease> {
    assertFeatureId(featureId, repositoryPath);
    const paths = await resolveLeasePaths(repositoryPath);
    await ensureSafeDirectory(paths.vibeDirectory, paths.root);
    await ensureSafeDirectory(paths.locksDirectory, paths.root);

    const owner = this.newOwner(featureId, paths.root);

    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      if (await tryCreateLease(paths.leasePath, owner)) {
        return this.handle(paths, owner);
      }

      const existing = await readLeaseIfPresent(paths.leasePath, paths.root);
      if (!existing) {
        await yieldToLeaseContender();
        continue;
      }

      if (existing.hostname !== this.hostname) {
        throw new ExecutionLeaseBusyError(
          paths.root,
          existing,
          'foreign-owner',
        );
      }

      let alive: boolean;
      try {
        alive = this.isProcessAlive(existing.pid);
      } catch (error) {
        throw new ExecutionLeaseStateError(
          'PROCESS_INSPECTION_FAILED',
          `Unable to determine whether execution owner PID ${existing.pid} is alive. The lock was left untouched.`,
          paths.root,
          { cause: error },
        );
      }

      if (alive) {
        throw new ExecutionLeaseBusyError(
          paths.root,
          existing,
          'live-local-owner',
        );
      }

      const reclaimed = await this.reclaimDeadOwner(paths, existing);
      if (reclaimed === 'retry') {
        await yieldToLeaseContender();
      }
    }

    throw new ExecutionLeaseStateError(
      'STALE_RECLAIM_CONTENDED',
      `Execution lease recovery remained contended after ${MAX_ACQUIRE_ATTEMPTS} attempts. The lock was left untouched; retry after the other contender finishes.`,
      paths.root,
    );
  }

  private newOwner(
    featureId: string,
    repositoryPath: string,
  ): ExecutionLeaseOwner {
    const token = this.tokenFactory();
    if (!TOKEN_PATTERN.test(token)) {
      throw new ExecutionLeaseStateError(
        'INVALID_LEASE_RECORD',
        'Execution lease token factory returned an invalid UUID token.',
        repositoryPath,
      );
    }

    const acquiredAt = this.now();
    if (Number.isNaN(acquiredAt.getTime())) {
      throw new ExecutionLeaseStateError(
        'INVALID_LEASE_RECORD',
        'Execution lease clock returned an invalid date.',
        repositoryPath,
      );
    }

    return {
      schemaVersion: EXECUTION_LEASE_SCHEMA_VERSION,
      token,
      featureId,
      pid: this.pid,
      hostname: this.hostname,
      acquiredAt: acquiredAt.toISOString(),
    };
  }

  private handle(
    paths: LeasePaths,
    owner: ExecutionLeaseOwner,
  ): ExecutionLease {
    let releasePromise: Promise<void> | undefined;

    return {
      repositoryPath: paths.root,
      owner: { ...owner },
      release: () => {
        releasePromise ??= releaseOwnedLease(paths, owner);
        return releasePromise;
      },
    };
  }

  private async reclaimDeadOwner(
    paths: LeasePaths,
    expectedOwner: ExecutionLeaseOwner,
  ): Promise<ReclaimResult> {
    const claimPath = join(
      paths.locksDirectory,
      `.execution.${expectedOwner.token}.reclaim`,
    );

    try {
      await link(paths.leasePath, claimPath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === 'EEXIST' || nodeError.code === 'ENOENT') {
        return 'retry';
      }
      throw new ExecutionLeaseStateError(
        'UNSAFE_LEASE_PATH',
        `Unable to claim the dead execution lease safely: ${errorMessage(error)}`,
        paths.root,
        { cause: error },
      );
    }

    try {
      const [leaseStat, claimStat] = await Promise.all([
        lstatIfExists(paths.leasePath),
        lstatIfExists(claimPath),
      ]);
      if (
        !leaseStat ||
        !claimStat ||
        !leaseStat.isFile() ||
        leaseStat.isSymbolicLink() ||
        !claimStat.isFile() ||
        claimStat.isSymbolicLink() ||
        leaseStat.dev !== claimStat.dev ||
        leaseStat.ino !== claimStat.ino
      ) {
        return 'retry';
      }

      const claimedOwner = await readLeaseRecord(claimPath, paths.root);
      if (
        claimedOwner.token !== expectedOwner.token ||
        claimedOwner.hostname !== this.hostname ||
        claimedOwner.pid !== expectedOwner.pid
      ) {
        return 'retry';
      }

      let stillAlive: boolean;
      try {
        stillAlive = this.isProcessAlive(claimedOwner.pid);
      } catch (error) {
        throw new ExecutionLeaseStateError(
          'PROCESS_INSPECTION_FAILED',
          `Unable to recheck dead execution owner PID ${claimedOwner.pid}. The lock was left untouched.`,
          paths.root,
          { cause: error },
        );
      }
      if (stillAlive) {
        throw new ExecutionLeaseBusyError(
          paths.root,
          claimedOwner,
          'live-local-owner',
        );
      }

      try {
        await unlink(paths.leasePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'retry';
        throw error;
      }
      return 'reclaimed';
    } finally {
      await unlink(claimPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}

async function releaseOwnedLease(
  paths: LeasePaths,
  expectedOwner: ExecutionLeaseOwner,
): Promise<void> {
  if (!(await inspectSafeDirectory(paths.vibeDirectory, paths.root))) return;
  if (!(await inspectSafeDirectory(paths.locksDirectory, paths.root))) return;

  const existing = await readLeaseIfPresent(paths.leasePath, paths.root);
  if (!existing) return;

  if (existing.token !== expectedOwner.token) {
    throw new ExecutionLeaseOwnershipError(
      paths.root,
      expectedOwner.token,
      existing,
    );
  }

  try {
    await unlink(paths.leasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function resolveLeasePaths(repositoryPath: string): Promise<LeasePaths> {
  if (typeof repositoryPath !== 'string' || !repositoryPath.trim()) {
    throw new ExecutionLeaseStateError(
      'INVALID_REPOSITORY',
      'Repository path must not be empty.',
      String(repositoryPath),
    );
  }

  let root: string;
  try {
    root = await realpath(resolve(repositoryPath));
  } catch (error) {
    throw new ExecutionLeaseStateError(
      'INVALID_REPOSITORY',
      `Repository path cannot be resolved: ${repositoryPath}.`,
      repositoryPath,
      { cause: error },
    );
  }

  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) {
    throw new ExecutionLeaseStateError(
      'INVALID_REPOSITORY',
      `Repository path is not a directory: ${root}.`,
      root,
    );
  }

  const vibeDirectory = join(root, '.vibe');
  const locksDirectory = join(vibeDirectory, 'locks');
  const leasePath = join(locksDirectory, LEASE_FILE_NAME);
  return { root, vibeDirectory, locksDirectory, leasePath };
}

async function ensureSafeDirectory(
  directory: string,
  repositoryPath: string,
): Promise<void> {
  const existing = await lstatIfExists(directory);
  if (existing) {
    assertSafeDirectory(existing, directory, repositoryPath);
    return;
  }

  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const created = await lstatIfExists(directory);
  if (!created) {
    throw new ExecutionLeaseStateError(
      'UNSAFE_LEASE_PATH',
      `Could not create execution lease directory: ${directory}.`,
      repositoryPath,
    );
  }
  assertSafeDirectory(created, directory, repositoryPath);
}

async function inspectSafeDirectory(
  directory: string,
  repositoryPath: string,
): Promise<boolean> {
  const stat = await lstatIfExists(directory);
  if (!stat) return false;
  assertSafeDirectory(stat, directory, repositoryPath);
  return true;
}

function assertSafeDirectory(
  stat: Awaited<ReturnType<typeof lstat>>,
  directory: string,
  repositoryPath: string,
): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ExecutionLeaseStateError(
      'UNSAFE_LEASE_PATH',
      `Expected a non-symlink execution lease directory: ${directory}.`,
      repositoryPath,
    );
  }
}

async function tryCreateLease(
  leasePath: string,
  owner: ExecutionLeaseOwner,
): Promise<boolean> {
  try {
    await writeFile(leasePath, `${JSON.stringify(owner, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function readLeaseIfPresent(
  leasePath: string,
  repositoryPath: string,
): Promise<ExecutionLeaseOwner | null> {
  const stat = await lstatIfExists(leasePath);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ExecutionLeaseStateError(
      'UNSAFE_LEASE_PATH',
      `Execution lease path is not a regular file: ${leasePath}.`,
      repositoryPath,
    );
  }
  return readLeaseRecord(leasePath, repositoryPath);
}

async function readLeaseRecord(
  path: string,
  repositoryPath: string,
): Promise<ExecutionLeaseOwner> {
  const stat = await lstatIfExists(path);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new ExecutionLeaseStateError(
      'UNSAFE_LEASE_PATH',
      `Execution lease path is not a regular file: ${path}.`,
      repositoryPath,
    );
  }
  if (stat.size > MAX_LEASE_RECORD_BYTES) {
    throw new ExecutionLeaseStateError(
      'INVALID_LEASE_RECORD',
      `Execution lease record exceeds ${MAX_LEASE_RECORD_BYTES} bytes and was left untouched.`,
      repositoryPath,
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new ExecutionLeaseStateError(
      'INVALID_LEASE_RECORD',
      `Execution lease record is invalid and was left untouched: ${errorMessage(error)}`,
      repositoryPath,
      { cause: error },
    );
  }

  if (!isRecord(input)) return invalidLeaseRecord(repositoryPath);
  if (input.schemaVersion !== EXECUTION_LEASE_SCHEMA_VERSION) {
    return invalidLeaseRecord(repositoryPath);
  }
  if (typeof input.token !== 'string' || !TOKEN_PATTERN.test(input.token)) {
    return invalidLeaseRecord(repositoryPath);
  }
  if (
    typeof input.featureId !== 'string' ||
    input.featureId.length > MAX_FEATURE_ID_LENGTH ||
    !SAFE_FEATURE_ID.test(input.featureId)
  ) {
    return invalidLeaseRecord(repositoryPath);
  }
  if (!Number.isSafeInteger(input.pid) || (input.pid as number) <= 0) {
    return invalidLeaseRecord(repositoryPath);
  }
  if (typeof input.hostname !== 'string' || !input.hostname.trim()) {
    return invalidLeaseRecord(repositoryPath);
  }
  if (
    typeof input.acquiredAt !== 'string' ||
    Number.isNaN(Date.parse(input.acquiredAt))
  ) {
    return invalidLeaseRecord(repositoryPath);
  }

  return {
    schemaVersion: EXECUTION_LEASE_SCHEMA_VERSION,
    token: input.token,
    featureId: input.featureId,
    pid: input.pid as number,
    hostname: input.hostname,
    acquiredAt: input.acquiredAt,
  };
}

function invalidLeaseRecord(repositoryPath: string): never {
  throw new ExecutionLeaseStateError(
    'INVALID_LEASE_RECORD',
    'Execution lease record has an unsupported shape and was left untouched.',
    repositoryPath,
  );
}

function assertFeatureId(featureId: string, repositoryPath: string): void {
  if (
    typeof featureId !== 'string' ||
    featureId.length === 0 ||
    featureId.length > MAX_FEATURE_ID_LENGTH ||
    !SAFE_FEATURE_ID.test(featureId)
  ) {
    throw new ExecutionLeaseStateError(
      'INVALID_FEATURE_ID',
      'Feature id must contain only lowercase letters and numbers separated by ., _, or -.',
      repositoryPath,
    );
  }
}

function localProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ESRCH') return false;
    if (nodeError.code === 'EPERM') return true;
    throw error;
  }
}

function validPid(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function yieldToLeaseContender(): Promise<void> {
  return new Promise((resolveYield) => setImmediate(resolveYield));
}
