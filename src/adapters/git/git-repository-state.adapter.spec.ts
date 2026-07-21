import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GitRepositoryStateAdapter } from './git-repository-state.adapter';
import { GitRepositoryStateError } from './git-repository-state.errors';

const execFileAsync = promisify(execFile);

describe('GitRepositoryStateAdapter', () => {
  let temporaryRoot: string;
  let adapter: GitRepositoryStateAdapter;

  beforeEach(async () => {
    temporaryRoot = await realpath(
      await mkdtemp(join(tmpdir(), 'vibecache-git-state-')),
    );
    adapter = new GitRepositoryStateAdapter();
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('inspects a clean repository and returns its HEAD commit', async () => {
    await initializeRepository(temporaryRoot);
    await commitFile(temporaryRoot, 'README.md', '# test\n');

    const expectedHead = await git(temporaryRoot, [
      'rev-parse',
      '--verify',
      'HEAD',
    ]);
    const state = await adapter.assertExecutionReady(temporaryRoot);

    expect(state).toEqual({
      targetPath: temporaryRoot,
      isInsideWorkTree: true,
      repositoryRoot: temporaryRoot,
      headCommit: expectedHead.trim(),
      statusEntries: [],
      isClean: true,
    });
  });

  it('returns dirty porcelain entries in deterministic path order', async () => {
    await initializeRepository(temporaryRoot);
    await commitFile(temporaryRoot, 'tracked.txt', 'original\n');
    await writeFile(join(temporaryRoot, 'tracked.txt'), 'changed\n');
    await writeFile(join(temporaryRoot, 'zeta.txt'), 'z\n');
    await writeFile(join(temporaryRoot, 'alpha.txt'), 'a\n');

    const state = await adapter.inspect(temporaryRoot);

    expect(state.isClean).toBe(false);
    expect(state.statusEntries).toEqual([
      {
        indexStatus: '?',
        workTreeStatus: '?',
        path: 'alpha.txt',
      },
      {
        indexStatus: ' ',
        workTreeStatus: 'M',
        path: 'tracked.txt',
      },
      {
        indexStatus: '?',
        workTreeStatus: '?',
        path: 'zeta.txt',
      },
    ]);
  });

  it('preserves both paths for staged renames', async () => {
    await initializeRepository(temporaryRoot);
    await commitFile(temporaryRoot, 'before.txt', 'content\n');
    await git(temporaryRoot, ['mv', 'before.txt', 'after.txt']);

    const state = await adapter.inspect(temporaryRoot);

    expect(state.statusEntries).toEqual([
      {
        indexStatus: 'R',
        workTreeStatus: ' ',
        path: 'after.txt',
        originalPath: 'before.txt',
      },
    ]);
  });

  it('rejects dirty repositories unless allowDirty is explicitly true', async () => {
    await initializeRepository(temporaryRoot);
    await commitFile(temporaryRoot, 'tracked.txt', 'original\n');
    await writeFile(join(temporaryRoot, 'tracked.txt'), 'changed\n');

    await expect(
      adapter.assertExecutionReady(temporaryRoot),
    ).rejects.toMatchObject({
      name: 'GitRepositoryStateError',
      code: 'DIRTY_WORK_TREE',
      targetPath: temporaryRoot,
    });

    await expect(
      adapter.assertExecutionReady(temporaryRoot, { allowDirty: true }),
    ).resolves.toMatchObject({
      isInsideWorkTree: true,
      repositoryRoot: temporaryRoot,
      isClean: false,
    });
  });

  it('does not treat ephemeral VibeCache lock and run state as user dirt', async () => {
    await initializeRepository(temporaryRoot);
    await commitFile(temporaryRoot, 'README.md', '# test\n');
    await mkdir(join(temporaryRoot, '.vibe', 'locks'), { recursive: true });
    await mkdir(join(temporaryRoot, '.vibe', 'runs'), { recursive: true });
    await writeFile(
      join(temporaryRoot, '.vibe', 'locks', 'execution.lock'),
      '{}\n',
    );
    await writeFile(join(temporaryRoot, '.vibe', 'runs', 'run.json'), '{}\n');

    await expect(
      adapter.assertExecutionReady(temporaryRoot),
    ).resolves.toMatchObject({ statusEntries: [], isClean: true });
    expect((await adapter.inspect(temporaryRoot)).isClean).toBe(false);
  });

  it('reports non-Git directories and rejects them for execution', async () => {
    await expect(adapter.inspect(temporaryRoot)).resolves.toEqual({
      targetPath: temporaryRoot,
      isInsideWorkTree: false,
      repositoryRoot: null,
      headCommit: null,
      statusEntries: [],
      isClean: false,
    });

    await expect(
      adapter.assertExecutionReady(temporaryRoot),
    ).rejects.toBeInstanceOf(GitRepositoryStateError);
    await expect(
      adapter.assertExecutionReady(temporaryRoot),
    ).rejects.toMatchObject({ code: 'NOT_GIT_REPOSITORY' });
  });

  it('rejects a nested path and points to the exact repository root', async () => {
    await initializeRepository(temporaryRoot);
    await commitFile(temporaryRoot, 'README.md', '# test\n');
    const nestedPath = join(temporaryRoot, 'src', 'nested');
    await mkdir(nestedPath, { recursive: true });

    const inspected = await adapter.inspect(nestedPath);
    expect(inspected).toMatchObject({
      targetPath: nestedPath,
      isInsideWorkTree: true,
      repositoryRoot: temporaryRoot,
    });

    await expect(
      adapter.assertExecutionReady(nestedPath),
    ).rejects.toMatchObject({
      code: 'REPOSITORY_ROOT_MISMATCH',
      targetPath: nestedPath,
      state: { repositoryRoot: temporaryRoot },
    });
  });

  it('represents an unborn repository with a null HEAD commit', async () => {
    await initializeRepository(temporaryRoot);

    const state = await adapter.assertExecutionReady(temporaryRoot);

    expect(state).toMatchObject({
      isInsideWorkTree: true,
      repositoryRoot: temporaryRoot,
      headCommit: null,
      statusEntries: [],
      isClean: true,
    });
  });
});

async function initializeRepository(repositoryRoot: string): Promise<void> {
  await git(repositoryRoot, ['init', '--quiet']);
  await git(repositoryRoot, ['config', 'user.email', 'vibecache@example.test']);
  await git(repositoryRoot, ['config', 'user.name', 'VibeCache Test']);
}

async function commitFile(
  repositoryRoot: string,
  relativePath: string,
  content: string,
): Promise<void> {
  await writeFile(join(repositoryRoot, relativePath), content);
  await git(repositoryRoot, ['add', '--', relativePath]);
  await git(repositoryRoot, ['commit', '--quiet', '-m', `Add ${relativePath}`]);
}

async function git(
  repositoryRoot: string,
  args: readonly string[],
): Promise<string> {
  const result = await execFileAsync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    shell: false,
  });
  return result.stdout;
}
