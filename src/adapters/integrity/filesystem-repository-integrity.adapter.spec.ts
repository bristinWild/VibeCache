import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemRepositoryIntegrityAdapter } from './filesystem-repository-integrity.adapter';

describe('FilesystemRepositoryIntegrityAdapter', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it('changes its digest for ignored Cliper content changes', async () => {
    const root = await repository();
    await mkdir(join(root, '.cliper'));
    const memory = join(root, '.cliper', 'memory.json');
    await writeFile(memory, '{"version":1}\n');
    const adapter = new FilesystemRepositoryIntegrityAdapter();

    const before = await adapter.snapshotProtectedPaths(root);
    await writeFile(memory, '{"version":2}\n');
    const after = await adapter.snapshotProtectedPaths(root);

    expect(after.digest).not.toBe(before.digest);
  });

  it('changes its digest for nested VibeCache state changes', async () => {
    const root = await repository();
    await mkdir(join(root, '.vibe'));
    await mkdir(join(root, '.vibe', 'runs'));
    const adapter = new FilesystemRepositoryIntegrityAdapter();
    const before = await adapter.snapshotProtectedPaths(root);

    await writeFile(join(root, '.vibe', 'runs', 'foreign.json'), '{}\n');

    expect((await adapter.snapshotProtectedPaths(root)).digest).not.toBe(
      before.digest,
    );
  });

  it('is deterministic and ignores ordinary source changes', async () => {
    const root = await repository();
    const adapter = new FilesystemRepositoryIntegrityAdapter();
    const first = await adapter.snapshotProtectedPaths(root);

    await writeFile(join(root, 'source.ts'), 'export const value = 1;\n');
    const second = await adapter.snapshotProtectedPaths(root);

    expect(second).toEqual(first);
  });

  it('refuses a symlinked protected root', async () => {
    const root = await repository();
    const external = await repository();
    await symlink(external, join(root, '.cliper'));

    await expect(
      new FilesystemRepositoryIntegrityAdapter().snapshotProtectedPaths(root),
    ).rejects.toThrow('must be a real directory');
  });

  async function repository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'vibecache-integrity-'));
    roots.push(root);
    return root;
  }
});
