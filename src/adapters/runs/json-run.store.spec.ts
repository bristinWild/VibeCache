import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEATURE_RUN_SCHEMA_VERSION,
  type FeatureRun,
} from '../../core/domain/feature-run';
import { assertSafeRunId, generateRunId, JsonRunStore } from './json-run.store';

describe('JsonRunStore', () => {
  let projectRoot: string;
  let store: JsonRunStore;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'vibecache-run-'));
    store = new JsonRunStore();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('round-trips a schema-versioned resumable run', async () => {
    const run = featureRun(projectRoot);

    await store.write(projectRoot, run);

    await expect(store.read(projectRoot, run.runId)).resolves.toEqual(run);
    const serialized = await readFile(runPath(projectRoot, run.runId), 'utf8');
    expect(JSON.parse(serialized)).toEqual(run);
    expect(serialized.endsWith('\n')).toBe(true);
  });

  it('writes stable JSON and is idempotent for an identical run', async () => {
    const run = featureRun(projectRoot);

    await store.write(projectRoot, run);
    const first = await readFile(runPath(projectRoot, run.runId), 'utf8');
    await store.write(projectRoot, run);
    const second = await readFile(runPath(projectRoot, run.runId), 'utf8');

    expect(second).toBe(first);
    await expect(readdir(join(projectRoot, '.vibe', 'runs'))).resolves.toEqual([
      `${run.runId}.json`,
    ]);
    expect(first.indexOf('"capsule"')).toBeLessThan(
      first.indexOf('"schemaVersion"'),
    );
  });

  it('returns null or an empty list before any run exists', async () => {
    const runId = generateRunId(new Date('2026-07-21T00:00:00.000Z'));

    await expect(store.read(projectRoot, runId)).resolves.toBeNull();
    await expect(store.list(projectRoot)).resolves.toEqual([]);
  });

  it('rejects invalid state before writing it', async () => {
    const invalid = {
      ...featureRun(projectRoot),
      schemaVersion: 99,
    } as unknown as FeatureRun;

    await expect(store.write(projectRoot, invalid)).rejects.toThrow();
    await expect(store.list(projectRoot)).resolves.toEqual([]);
  });

  it('rejects a tampered run on read', async () => {
    const run = featureRun(projectRoot);
    await store.write(projectRoot, run);
    const tampered = {
      ...run,
      status: 'installed',
      currentWave: null,
      nextWave: null,
    };
    await writeFile(
      runPath(projectRoot, run.runId),
      JSON.stringify(tampered),
      'utf8',
    );

    await expect(store.read(projectRoot, run.runId)).rejects.toThrow(
      'Invalid feature run',
    );
  });

  it('rejects a run whose embedded id differs from its filename', async () => {
    const run = featureRun(projectRoot);
    await store.write(projectRoot, run);
    const otherRunId = fixedRunId(2);
    await writeFile(
      runPath(projectRoot, run.runId),
      JSON.stringify({ ...run, runId: otherRunId }),
      'utf8',
    );

    await expect(store.read(projectRoot, run.runId)).rejects.toThrow(
      'does not match',
    );
  });

  it.each([
    '',
    '.',
    '..',
    '../outside',
    'nested/run',
    'nested\\run',
    '/absolute',
    '20260721t000000000z-short',
    '20260721T000000000Z-00000000000000000000',
    '20260721t000000000z-0000000000000000000g',
  ])('rejects unsafe run id %p', async (runId) => {
    expect(() => assertSafeRunId(runId)).toThrow('Run id');
    await expect(store.read(projectRoot, runId)).rejects.toThrow('Run id');
  });

  it('rejects a symbolic-link .vibe directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vibecache-run-outside-'));
    try {
      await symlink(outside, join(projectRoot, '.vibe'));

      await expect(
        store.write(projectRoot, featureRun(projectRoot)),
      ).rejects.toThrow('non-symlink directory');
      await expect(readdir(outside)).resolves.toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a symbolic-link runs directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'vibecache-run-outside-'));
    try {
      await mkdir(join(projectRoot, '.vibe'));
      await symlink(outside, join(projectRoot, '.vibe', 'runs'));

      await expect(
        store.write(projectRoot, featureRun(projectRoot)),
      ).rejects.toThrow('non-symlink directory');
      await expect(store.list(projectRoot)).rejects.toThrow(
        'non-symlink directory',
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a symbolic-link run file without reading or replacing its target', async () => {
    const run = featureRun(projectRoot);
    const outside = join(projectRoot, 'outside.json');
    await mkdir(join(projectRoot, '.vibe'));
    await mkdir(join(projectRoot, '.vibe', 'runs'));
    await writeFile(outside, 'do-not-replace', 'utf8');
    await symlink(outside, runPath(projectRoot, run.runId));

    await expect(store.read(projectRoot, run.runId)).rejects.toThrow(
      'not a regular file',
    );
    await expect(store.write(projectRoot, run)).rejects.toThrow(
      'not a regular file',
    );
    await expect(store.list(projectRoot)).rejects.toThrow('not a regular file');
    await expect(readFile(outside, 'utf8')).resolves.toBe('do-not-replace');
  });

  it('lists runs deterministically in newest-first run-id order', async () => {
    const oldest = featureRun(projectRoot, fixedRunId(1));
    const middle = featureRun(projectRoot, fixedRunId(2));
    const newest = featureRun(
      projectRoot,
      '20260722t000000000z-00000000000000000000',
    );

    await store.write(projectRoot, middle);
    await store.write(projectRoot, oldest);
    await store.write(projectRoot, newest);
    await writeFile(
      join(projectRoot, '.vibe', 'runs', '.interrupted.tmp'),
      'partial',
      'utf8',
    );

    const runs = await store.list(projectRoot);
    expect(runs.map((run) => run.runId)).toEqual([
      newest.runId,
      middle.runId,
      oldest.runId,
    ]);
  });

  it('rejects unexpected JSON filenames while listing managed runs', async () => {
    await store.write(projectRoot, featureRun(projectRoot));
    await writeFile(
      join(projectRoot, '.vibe', 'runs', 'not-a-run.json'),
      '{}',
      'utf8',
    );

    await expect(store.list(projectRoot)).rejects.toThrow(
      'Invalid run filename',
    );
  });
});

describe('generateRunId', () => {
  it('generates safe, collision-resistant, time-sortable ids', () => {
    const earlier = generateRunId(new Date('2026-07-21T01:02:03.004Z'));
    const later = generateRunId(new Date('2026-07-22T01:02:03.004Z'));
    const sameInstant = generateRunId(new Date('2026-07-21T01:02:03.004Z'));

    expect(() => assertSafeRunId(earlier)).not.toThrow();
    expect(earlier).toMatch(/^20260721t010203004z-[a-f0-9]{20}$/);
    expect(earlier < later).toBe(true);
    expect(sameInstant).not.toBe(earlier);
  });

  it('rejects an invalid generation timestamp', () => {
    expect(() => generateRunId(new Date('invalid'))).toThrow('invalid date');
  });
});

function featureRun(projectRoot: string, runId = fixedRunId(1)): FeatureRun {
  return {
    schemaVersion: FEATURE_RUN_SCHEMA_VERSION,
    runId,
    featureId: 'stripe-subscriptions',
    capsule: {
      id: 'stripe-subscriptions',
      version: '0.1.0',
      digest: 'sha256:capsule-fixture',
    },
    repository: {
      path: projectRoot,
      startingCommit: 'abc1234',
    },
    status: 'running',
    currentWave: 1,
    nextWave: 2,
    choices: {
      cancellation: 'end-of-period',
      plans: ['monthly', 'yearly'],
      metadata: { trialDays: 14, enabled: true },
    },
    bindings: {
      'database-schema': 'prisma/schema.prisma',
      'server-route': 'src/app/api',
    },
    waveResults: [
      {
        wave: 1,
        taskIds: ['subscription-schema'],
        status: 'completed',
        agents: [
          {
            name: 'codex',
            model: 'gpt-5',
            sessionId: 'session-1',
            status: 'completed',
            taskIds: ['subscription-schema'],
            summary: 'Added the subscription data model.',
            changedFiles: ['prisma/schema.prisma'],
            startedAt: '2026-07-21T00:00:01.000Z',
            completedAt: '2026-07-21T00:00:20.000Z',
          },
        ],
        verification: {
          status: 'passed',
          summary: 'Schema validation passed.',
          checks: [
            {
              id: 'prisma-validate',
              status: 'passed',
              durationMs: 125,
            },
          ],
          verifiedAt: '2026-07-21T00:00:21.000Z',
        },
        startedAt: '2026-07-21T00:00:01.000Z',
        completedAt: '2026-07-21T00:00:21.000Z',
      },
    ],
    timestamps: {
      createdAt: '2026-07-21T00:00:00.000Z',
      startedAt: '2026-07-21T00:00:01.000Z',
      updatedAt: '2026-07-21T00:00:22.000Z',
    },
  };
}

function fixedRunId(suffix: number): string {
  return `20260721t000000000z-${suffix.toString(16).padStart(20, '0')}`;
}

function runPath(projectRoot: string, runId: string): string {
  return join(projectRoot, '.vibe', 'runs', `${runId}.json`);
}
