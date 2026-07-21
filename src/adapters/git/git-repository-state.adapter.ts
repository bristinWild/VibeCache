import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  ExecutionReadinessOptions,
  RepositoryStatePort,
  RepositoryStateSnapshot,
  RepositoryStatusEntry,
} from '../../core/ports/repository-state.port';
import { GitRepositoryStateError } from './git-repository-state.errors';

const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

@Injectable()
export class GitRepositoryStateAdapter implements RepositoryStatePort {
  async inspect(targetPath: string): Promise<RepositoryStateSnapshot> {
    const canonicalTarget = await canonicalDirectory(targetPath);
    const workTreeResult = await runGit(canonicalTarget, [
      'rev-parse',
      '--is-inside-work-tree',
    ]);

    if (
      isNotGitRepository(workTreeResult) ||
      (workTreeResult.exitCode === 0 &&
        workTreeResult.stdout.trim() === 'false')
    ) {
      return nonGitState(canonicalTarget);
    }

    if (
      workTreeResult.exitCode !== 0 ||
      workTreeResult.stdout.trim() !== 'true'
    ) {
      throw inspectionFailed(
        canonicalTarget,
        ['rev-parse', '--is-inside-work-tree'],
        workTreeResult,
      );
    }

    const rootResult = await runGit(canonicalTarget, [
      'rev-parse',
      '--show-toplevel',
    ]);
    assertSuccessful(
      canonicalTarget,
      ['rev-parse', '--show-toplevel'],
      rootResult,
    );

    const reportedRoot = rootResult.stdout.trim();
    if (!reportedRoot) {
      throw new GitRepositoryStateError(
        'GIT_INSPECTION_FAILED',
        `Git did not report a repository root for "${canonicalTarget}". Verify the repository metadata and try again.`,
        canonicalTarget,
      );
    }

    let repositoryRoot: string;
    try {
      repositoryRoot = await realpath(reportedRoot);
    } catch (error) {
      throw new GitRepositoryStateError(
        'GIT_INSPECTION_FAILED',
        `Git reported repository root "${reportedRoot}", but that path cannot be resolved. Repair the repository worktree and try again.`,
        canonicalTarget,
        undefined,
        { cause: error },
      );
    }

    const [headResult, statusResult] = await Promise.all([
      runGit(canonicalTarget, ['rev-parse', '--verify', '--quiet', 'HEAD']),
      runGit(canonicalTarget, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]),
    ]);

    if (headResult.exitCode !== 0 && headResult.exitCode !== 1) {
      throw inspectionFailed(
        canonicalTarget,
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        headResult,
      );
    }
    assertSuccessful(
      canonicalTarget,
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      statusResult,
    );

    const statusEntries = parsePorcelainStatus(statusResult.stdout);

    return {
      targetPath: canonicalTarget,
      isInsideWorkTree: true,
      repositoryRoot,
      headCommit:
        headResult.exitCode === 0 ? headResult.stdout.trim() || null : null,
      statusEntries,
      isClean: statusEntries.length === 0,
    };
  }

  async assertExecutionReady(
    targetPath: string,
    options: ExecutionReadinessOptions = {},
  ): Promise<RepositoryStateSnapshot> {
    const state = await this.inspect(targetPath);

    if (!state.isInsideWorkTree || state.repositoryRoot === null) {
      throw new GitRepositoryStateError(
        'NOT_GIT_REPOSITORY',
        `"${state.targetPath}" is not a Git working tree. Initialize it with \`git init\`, or choose an existing repository root.`,
        state.targetPath,
        state,
      );
    }

    if (state.targetPath !== state.repositoryRoot) {
      throw new GitRepositoryStateError(
        'REPOSITORY_ROOT_MISMATCH',
        `"${state.targetPath}" is inside the Git repository at "${state.repositoryRoot}", but execution must target the exact repository root. Run the command again with --path "${state.repositoryRoot}".`,
        state.targetPath,
        state,
      );
    }

    const executionEntries = state.statusEntries.filter(
      (entry) => !isEphemeralVibeCacheState(entry.path),
    );

    if (executionEntries.length > 0 && options.allowDirty !== true) {
      const changedPaths = executionEntries.map(formatStatusEntry).join(', ');

      throw new GitRepositoryStateError(
        'DIRTY_WORK_TREE',
        `The Git working tree at "${state.repositoryRoot}" has uncommitted changes: ${changedPaths}. Commit, stash, or revert them before execution, or explicitly allow a dirty tree.`,
        state.targetPath,
        state,
      );
    }

    return {
      ...state,
      statusEntries: executionEntries,
      isClean: executionEntries.length === 0,
    };
  }
}

function isEphemeralVibeCacheState(path: string): boolean {
  return (
    path === '.vibe/locks' ||
    path.startsWith('.vibe/locks/') ||
    path === '.vibe/runs' ||
    path.startsWith('.vibe/runs/')
  );
}

async function canonicalDirectory(targetPath: string): Promise<string> {
  const absoluteTarget = resolve(targetPath);

  let targetStats;
  try {
    targetStats = await stat(absoluteTarget);
  } catch (error) {
    throw new GitRepositoryStateError(
      'TARGET_NOT_FOUND',
      `Repository target does not exist: "${absoluteTarget}". Choose an existing directory and try again.`,
      absoluteTarget,
      undefined,
      { cause: error },
    );
  }

  if (!targetStats.isDirectory()) {
    throw new GitRepositoryStateError(
      'TARGET_NOT_DIRECTORY',
      `Repository target is not a directory: "${absoluteTarget}". Choose the repository directory instead of a file.`,
      absoluteTarget,
    );
  }

  return realpath(absoluteTarget);
}

function runGit(
  cwd: string,
  args: readonly string[],
): Promise<GitCommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        shell: false,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolveCommand({ exitCode: 0, stdout, stderr });
          return;
        }

        if (error.code === 'ENOENT') {
          rejectCommand(
            new GitRepositoryStateError(
              'GIT_UNAVAILABLE',
              'Git is not available on PATH. Install Git before running repository execution.',
              cwd,
              undefined,
              { cause: error },
            ),
          );
          return;
        }

        if (typeof error.code !== 'number') {
          rejectCommand(
            new GitRepositoryStateError(
              'GIT_INSPECTION_FAILED',
              `Unable to inspect Git state at "${cwd}": ${error.message}`,
              cwd,
              undefined,
              { cause: error },
            ),
          );
          return;
        }

        resolveCommand({ exitCode: error.code, stdout, stderr });
      },
    );
  });
}

function isNotGitRepository(result: GitCommandResult): boolean {
  return result.exitCode !== 0 && /not a git repository/i.test(result.stderr);
}

function assertSuccessful(
  targetPath: string,
  args: readonly string[],
  result: GitCommandResult,
): void {
  if (result.exitCode !== 0) {
    throw inspectionFailed(targetPath, args, result);
  }
}

function inspectionFailed(
  targetPath: string,
  args: readonly string[],
  result: GitCommandResult,
): GitRepositoryStateError {
  const detail =
    result.stderr.trim() || `Git exited with code ${result.exitCode}`;

  return new GitRepositoryStateError(
    'GIT_INSPECTION_FAILED',
    `Unable to inspect Git state at "${targetPath}" with \`git ${args.join(' ')}\`: ${detail}`,
    targetPath,
  );
}

function nonGitState(targetPath: string): RepositoryStateSnapshot {
  return {
    targetPath,
    isInsideWorkTree: false,
    repositoryRoot: null,
    headCommit: null,
    statusEntries: [],
    isClean: false,
  };
}

export function parsePorcelainStatus(
  porcelainOutput: string,
): RepositoryStatusEntry[] {
  const records = porcelainOutput.split('\0');
  const entries: RepositoryStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    if (record.length < 4 || record[2] !== ' ') {
      throw new GitRepositoryStateError(
        'GIT_INSPECTION_FAILED',
        'Git returned malformed porcelain status output. Upgrade or repair Git and try again.',
        '',
      );
    }

    const indexStatus = record[0];
    const workTreeStatus = record[1];
    const path = record.slice(3);
    const renamedOrCopied =
      indexStatus === 'R' ||
      indexStatus === 'C' ||
      workTreeStatus === 'R' ||
      workTreeStatus === 'C';
    const originalPath = renamedOrCopied ? records[++index] : undefined;

    if (!path || (renamedOrCopied && !originalPath)) {
      throw new GitRepositoryStateError(
        'GIT_INSPECTION_FAILED',
        'Git returned incomplete porcelain status output. Upgrade or repair Git and try again.',
        '',
      );
    }

    entries.push({
      indexStatus,
      workTreeStatus,
      path,
      ...(originalPath ? { originalPath } : {}),
    });
  }

  return entries.sort(compareStatusEntries);
}

function compareStatusEntries(
  left: RepositoryStatusEntry,
  right: RepositoryStatusEntry,
): number {
  return (
    compareText(left.path, right.path) ||
    compareText(left.originalPath ?? '', right.originalPath ?? '') ||
    compareText(left.indexStatus, right.indexStatus) ||
    compareText(left.workTreeStatus, right.workTreeStatus)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatStatusEntry(entry: RepositoryStatusEntry): string {
  const status = `${entry.indexStatus}${entry.workTreeStatus}`;
  return entry.originalPath
    ? `${status} ${entry.originalPath} -> ${entry.path}`
    : `${status} ${entry.path}`;
}
