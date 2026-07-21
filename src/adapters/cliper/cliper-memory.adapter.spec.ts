import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  CliperMemoryAdapter,
  CliperStructuredSearchClient,
} from './cliper-memory.adapter';
import { CliperMemoryError } from './cliper-memory.errors';

jest.mock('cliper-memory', () => ({
  Cliper: class MockCliper {},
}));

const fixtureRoot = resolve(
  __dirname,
  '../../../test/fixtures/next-supabase-prisma',
);
const isolatedHome = join(fixtureRoot, '.isolated-home');

class NativeCliperSearchClient implements CliperStructuredSearchClient {
  searchStructured(options: {
    path: string;
    query: string;
    profile: 'architecture' | 'dependency' | 'repository';
  }): Promise<unknown> {
    const script = `
      const { Cliper } = require('cliper-memory');
      const options = JSON.parse(process.argv[1]);
      new Cliper()
        .searchStructured(options)
        .then((result) => process.stdout.write(JSON.stringify(result)))
        .catch((error) => {
          process.stderr.write(error && error.stack ? error.stack : String(error));
          process.exitCode = 1;
        });
    `;

    return Promise.resolve(
      JSON.parse(
        execFileSync(
          process.execPath,
          ['-e', script, JSON.stringify(options)],
          {
            cwd: resolve(__dirname, '../../..'),
            encoding: 'utf8',
            env: { ...process.env, HOME: isolatedHome },
          },
        ),
      ) as unknown,
    );
  }
}

describe('CliperMemoryAdapter', () => {
  it('runs focused searches and normalizes duplicate SDK memories', async () => {
    const sharedMemory = {
      id: 'file:src/lib/prisma.ts',
      type: 'file',
      title: 'src/lib/prisma.ts',
      content: 'Shared Prisma client for server-side database access.',
      metadata: { role: 'database-client' },
      tags: ['prisma'],
      relationships: ['package:@prisma/client'],
    };
    const searchStructured = jest
      .fn<
        ReturnType<CliperStructuredSearchClient['searchStructured']>,
        Parameters<CliperStructuredSearchClient['searchStructured']>
      >()
      .mockResolvedValue({ files: [sharedMemory] });
    const adapter = new CliperMemoryAdapter({ searchStructured });

    const snapshot = await adapter.inspect(fixtureRoot);

    expect(searchStructured).toHaveBeenCalledTimes(3);
    expect(
      searchStructured.mock.calls.map(([request]) => request.profile),
    ).toEqual(['architecture', 'dependency', 'repository']);
    expect(
      searchStructured.mock.calls.every(
        ([request]) => request.path === fixtureRoot && request.query.length > 0,
      ),
    ).toBe(true);
    expect(snapshot).toEqual({
      repositoryPath: fixtureRoot,
      memories: [sharedMemory],
      metadata: {
        dataset: 'cliper-next-supabase-prisma',
        generatedAt: '2026-07-21T00:00:00.000Z',
      },
    });
  });

  it('reads and deduplicates the deterministic local-JSON fixture', async () => {
    const adapter = new CliperMemoryAdapter(new NativeCliperSearchClient());

    const snapshot = await adapter.inspect(fixtureRoot);
    const identities = snapshot.memories.map(
      (memory) => `${memory.type}:${memory.id}`,
    );

    expect(snapshot.repositoryPath).toBe(fixtureRoot);
    expect(snapshot.metadata).toEqual({
      dataset: 'cliper-next-supabase-prisma',
      generatedAt: '2026-07-21T00:00:00.000Z',
    });
    expect(new Set(identities).size).toBe(identities.length);
    expect(snapshot.memories.length).toBeGreaterThanOrEqual(8);
    expect(snapshot.memories.map((memory) => memory.type)).toEqual(
      expect.arrayContaining([
        'architecture',
        'file',
        'dependency',
        'package',
        'repository',
      ]),
    );

    const supabaseMemory = snapshot.memories.find(
      (memory) => memory.id === 'file:src/lib/supabase/server.ts',
    );
    expect(supabaseMemory).toBeDefined();
    expect(supabaseMemory?.content).toContain('Supabase');
    expect(supabaseMemory?.metadata).toEqual({
      framework: 'Next.js App Router',
      role: 'server-auth-client',
    });
    expect(supabaseMemory?.tags).toContain('authentication');
    expect(supabaseMemory?.tags).toContain('supabase');
  });

  it('rejects relative repository paths before querying Cliper', async () => {
    const searchStructured = jest.fn();
    const adapter = new CliperMemoryAdapter({ searchStructured });

    const error = await captureCliperError(
      adapter.inspect('relative/repository'),
    );

    expect(error.code).toBe('INVALID_REPOSITORY_PATH');
    expect(error.message).toContain('path.resolve');
    expect(searchStructured).not.toHaveBeenCalled();
  });

  it('explains how to initialize a repository with missing metadata', async () => {
    const adapter = new CliperMemoryAdapter(
      {
        searchStructured: jest.fn(),
      },
      { autoInitialize: false },
    );
    const existingDirectoryWithoutMemory = join(fixtureRoot, 'src');

    const error = await captureCliperError(
      adapter.inspect(existingDirectoryWithoutMemory),
    );

    expect(error.code).toBe('MEMORY_NOT_INITIALIZED');
    expect(error.message).toContain('cliper init --path');
    expect(error.repositoryPath).toBe(existingDirectoryWithoutMemory);
  });
});

async function captureCliperError(
  promise: Promise<unknown>,
): Promise<CliperMemoryError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CliperMemoryError) return error;
    throw error;
  }

  throw new Error('Expected CliperMemoryError, but the promise resolved.');
}
