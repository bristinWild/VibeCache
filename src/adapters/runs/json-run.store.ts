import { randomBytes, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  FEATURE_RUN_ID_PATTERN,
  parseFeatureRun,
  type FeatureRun,
} from '../../core/domain/feature-run';
import type { RunStorePort } from '../../core/ports/run-store.port';

const RUN_ID_RANDOM_BYTES = 10;

export class JsonRunStore implements RunStorePort {
  async list(projectRoot: string): Promise<FeatureRun[]> {
    const paths = await resolveStorePaths(projectRoot);
    if (!(await inspectManagedDirectory(paths.vibeDirectory, false))) {
      return [];
    }
    if (!(await inspectManagedDirectory(paths.runsDirectory, false))) {
      return [];
    }

    const entries = await readdir(paths.runsDirectory, {
      withFileTypes: true,
    });
    const runIds: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name.endsWith('.tmp')) {
        continue;
      }
      if (!entry.name.endsWith('.json')) {
        continue;
      }

      const runId = entry.name.slice(0, -'.json'.length);
      try {
        assertSafeRunId(runId);
      } catch (error) {
        throw new Error(
          `Invalid run filename in ${paths.runsDirectory}: ${entry.name}. ${errorMessage(error)}`,
        );
      }

      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(
          `Run path is not a regular file: ${join(paths.runsDirectory, entry.name)}`,
        );
      }
      runIds.push(runId);
    }

    runIds.sort(compareRunIdsNewestFirst);
    const runs: FeatureRun[] = [];
    for (const runId of runIds) {
      const run = await this.read(paths.root, runId);
      if (!run) {
        throw new Error(`Run disappeared while listing: ${runId}.`);
      }
      runs.push(run);
    }
    return runs;
  }

  async read(projectRoot: string, runId: string): Promise<FeatureRun | null> {
    assertSafeRunId(runId);
    const paths = await resolveStorePaths(projectRoot, runId);
    if (!(await inspectManagedDirectory(paths.vibeDirectory, false))) {
      return null;
    }
    if (!(await inspectManagedDirectory(paths.runsDirectory, false))) {
      return null;
    }

    const runStat = await lstatIfExists(paths.runPath);
    if (!runStat) {
      return null;
    }
    if (runStat.isSymbolicLink() || !runStat.isFile()) {
      throw new Error(`Run path is not a regular file: ${paths.runPath}`);
    }

    let input: unknown;
    try {
      input = JSON.parse(await readFile(paths.runPath, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid feature run "${runId}": ${errorMessage(error)}`);
    }

    let run: FeatureRun;
    try {
      run = parseFeatureRun(input);
    } catch (error) {
      throw new Error(`Invalid feature run "${runId}": ${errorMessage(error)}`);
    }

    if (run.runId !== runId) {
      throw new Error('Feature run id does not match its run filename.');
    }
    await assertRepositoryMatches(paths.root, run.repository.path);
    return run;
  }

  async write(projectRoot: string, input: FeatureRun): Promise<void> {
    const run = parseFeatureRun(input);
    assertSafeRunId(run.runId);
    const paths = await resolveStorePaths(projectRoot, run.runId);
    await assertRepositoryMatches(paths.root, run.repository.path);

    await ensureManagedDirectory(paths.vibeDirectory);
    await ensureManagedDirectory(paths.runsDirectory);

    const existingStat = await lstatIfExists(paths.runPath);
    assertSafeRunFile(existingStat, paths.runPath);

    const serialized = stableSerialize(run);
    if (existingStat) {
      const existing = await readFile(paths.runPath, 'utf8');
      if (existing === serialized) {
        return;
      }
    }

    const temporaryPath = join(
      paths.runsDirectory,
      `.${run.runId}.${process.pid}.${randomUUID()}.tmp`,
    );

    try {
      await writeFile(temporaryPath, serialized, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });

      // Recheck immediately before the atomic replacement. This prevents a
      // pre-existing symlink from being silently treated as a run file.
      assertSafeRunFile(await lstatIfExists(paths.runPath), paths.runPath);
      await rename(temporaryPath, paths.runPath);
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
  }
}

/**
 * Produces a lexicographically time-sortable id with 80 random bits.
 * Example: 20260721t123456789z-f8d1d0fe105f433eaf2b
 */
export function generateRunId(now: Date = new Date()): string {
  if (Number.isNaN(now.getTime())) {
    throw new TypeError('Cannot generate a run id from an invalid date.');
  }

  const timestamp = now
    .toISOString()
    .replaceAll('-', '')
    .replaceAll(':', '')
    .replace('.', '')
    .toLowerCase();
  return `${timestamp}-${randomBytes(RUN_ID_RANDOM_BYTES).toString('hex')}`;
}

export function assertSafeRunId(runId: string): void {
  if (typeof runId !== 'string' || !FEATURE_RUN_ID_PATTERN.test(runId)) {
    throw new TypeError(
      'Run id must use the generated <UTC timestamp>-<20 lowercase hex characters> format.',
    );
  }
}

interface StorePaths {
  root: string;
  vibeDirectory: string;
  runsDirectory: string;
  runPath: string;
}

async function resolveStorePaths(
  projectRoot: string,
  runId?: string,
): Promise<StorePaths> {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) {
    throw new TypeError('Project root must not be empty.');
  }

  const root = await realpath(resolve(projectRoot));
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) {
    throw new TypeError(`Project root is not a directory: ${root}.`);
  }

  const vibeDirectory = join(root, '.vibe');
  const runsDirectory = join(vibeDirectory, 'runs');
  const runPath = runId ? join(runsDirectory, `${runId}.json`) : runsDirectory;

  if (runId) {
    const relativeRunPath = relative(runsDirectory, runPath);
    if (
      relativeRunPath.startsWith('..') ||
      relativeRunPath.includes('/') ||
      relativeRunPath.includes('\\')
    ) {
      throw new Error(`Unsafe run path for run id "${runId}".`);
    }
  }

  return { root, vibeDirectory, runsDirectory, runPath };
}

async function assertRepositoryMatches(
  storeRoot: string,
  repositoryPath: string,
): Promise<void> {
  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath(resolve(repositoryPath));
  } catch (error) {
    throw new Error(
      `Feature run repository path cannot be resolved: ${errorMessage(error)}`,
    );
  }

  if (repositoryRoot !== storeRoot) {
    throw new Error(
      `Feature run repository path does not match store root: ${repositoryPath}.`,
    );
  }
}

async function ensureManagedDirectory(directory: string): Promise<void> {
  const existing = await lstatIfExists(directory);
  if (existing) {
    assertDirectoryIsSafe(existing, directory);
    return;
  }

  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'EEXIST') {
      throw error;
    }
  }

  const created = await lstatIfExists(directory);
  if (!created) {
    throw new Error(`Could not create run directory: ${directory}.`);
  }
  assertDirectoryIsSafe(created, directory);
}

async function inspectManagedDirectory(
  directory: string,
  mustExist: boolean,
): Promise<boolean> {
  const stat = await lstatIfExists(directory);
  if (!stat) {
    if (mustExist) {
      throw new Error(`Directory does not exist: ${directory}.`);
    }
    return false;
  }
  assertDirectoryIsSafe(stat, directory);
  return true;
}

function assertDirectoryIsSafe(
  stat: Awaited<ReturnType<typeof lstat>>,
  directory: string,
): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Expected a non-symlink directory: ${directory}.`);
  }
}

function assertSafeRunFile(
  stat: Awaited<ReturnType<typeof lstat>> | null,
  path: string,
): void {
  if (!stat) {
    return;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Run path is not a regular file: ${path}`);
  }
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function stableSerialize(value: FeatureRun): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => compareAscii(left, right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}

function compareRunIdsNewestFirst(left: string, right: string): number {
  return -compareAscii(left, right);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
