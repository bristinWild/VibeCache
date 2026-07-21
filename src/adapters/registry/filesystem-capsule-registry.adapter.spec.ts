import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { TaskGraphCompiler } from '../../core/services/task-graph.compiler';
import { CapsuleRegistryError } from './capsule-registry.errors';
import { FilesystemCapsuleRegistryAdapter } from './filesystem-capsule-registry.adapter';

const registryRoot = resolve(__dirname, '../../../registry');

describe('FilesystemCapsuleRegistryAdapter', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('loads the default Stripe capsule and compiles stable execution waves', async () => {
    const registry = new FilesystemCapsuleRegistryAdapter();

    const capsule = await registry.find('stripe-subscriptions');

    expect(registry.registryRoot).toBe(registryRoot);
    expect(capsule).not.toBeNull();
    expect(capsule?.compatibility).toEqual([
      {
        dimension: 'framework',
        oneOf: ['nextjs-app-router'],
        required: true,
      },
      { dimension: 'auth', oneOf: ['supabase'], required: true },
      { dimension: 'orm', oneOf: ['prisma'], required: true },
    ]);
    expect(capsule?.requires.map(({ capability }) => capability)).toEqual([
      'user-identity',
      'persistent-database',
      'server-routes',
    ]);
    expect(capsule?.questions).toContainEqual(
      expect.objectContaining({
        id: 'cancellation-behavior',
        default: 'end-of-period',
      }),
    );

    if (!capsule) throw new Error('Expected Stripe capsule to exist.');
    expect(new TaskGraphCompiler().compile(capsule.tasks).waves).toEqual([
      ['subscription-schema'],
      ['checkout', 'webhook'],
      ['verify'],
    ]);
  });

  it('lists valid capsules in deterministic feature-id order', async () => {
    const root = createTemporaryRegistry();
    writeCapsule(root, 'zeta-feature');
    writeCapsule(root, 'alpha-feature');
    mkdirSync(join(root, '.ignored'), { recursive: true });

    const capsules = await new FilesystemCapsuleRegistryAdapter(root).list();

    expect(capsules.map(({ id }) => id)).toEqual([
      'alpha-feature',
      'zeta-feature',
    ]);
  });

  it('returns null when a safe feature id is not installed', async () => {
    await expect(
      new FilesystemCapsuleRegistryAdapter(registryRoot).find(
        'missing-feature',
      ),
    ).resolves.toBeNull();
  });

  it.each([
    '../stripe-subscriptions',
    'stripe/subscriptions',
    'Stripe-Subscriptions',
    'stripe--subscriptions',
    '',
  ])('rejects unsafe feature id %p', async (featureId) => {
    const error = await captureRegistryError(
      new FilesystemCapsuleRegistryAdapter(registryRoot).find(featureId),
    );

    expect(error.code).toBe('INVALID_FEATURE_ID');
  });

  it('rejects capsules reached through a symlink outside the registry', async () => {
    const root = createTemporaryRegistry();
    const outside = createTemporaryRegistry();
    writeCapsule(outside, 'linked-feature');
    symlinkSync(
      join(outside, 'linked-feature'),
      join(root, 'linked-feature'),
      'dir',
    );

    const error = await captureRegistryError(
      new FilesystemCapsuleRegistryAdapter(root).find('linked-feature'),
    );

    expect(error.code).toBe('UNSAFE_CAPSULE_PATH');
  });

  it('reports an id that does not match its registry directory', async () => {
    const root = createTemporaryRegistry();
    writeCapsule(root, 'expected-feature', 'different-feature');

    const error = await captureRegistryError(
      new FilesystemCapsuleRegistryAdapter(root).find('expected-feature'),
    );

    expect(error.code).toBe('INVALID_CAPSULE');
    expect(error.message).toContain('must match registry directory');
  });

  function createTemporaryRegistry(): string {
    const root = mkdtempSync(join(tmpdir(), 'vibecache-registry-'));
    temporaryRoots.push(root);
    return root;
  }
});

function writeCapsule(
  registry: string,
  directoryId: string,
  capsuleId = directoryId,
): void {
  const capsulePath = join(registry, directoryId, 'capsule.yaml');
  mkdirSync(dirname(capsulePath), { recursive: true });
  writeFileSync(
    capsulePath,
    stringify({
      schemaVersion: 1,
      id: capsuleId,
      version: '0.1.0',
      name: capsuleId,
      summary: `Fixture capsule for ${capsuleId}.`,
      provides: ['fixture-capability'],
      tasks: [
        {
          id: 'implement',
          title: 'Implement fixture',
          instructions: ['Implement the fixture capability.'],
        },
      ],
    }),
    'utf8',
  );
}

async function captureRegistryError(
  promise: Promise<unknown>,
): Promise<CapsuleRegistryError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CapsuleRegistryError) return error;
    throw error;
  }

  throw new Error('Expected CapsuleRegistryError, but the promise resolved.');
}
