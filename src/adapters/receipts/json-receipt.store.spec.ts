import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEATURE_RECEIPT_SCHEMA_VERSION,
  type FeatureReceipt,
  type ReceiptCheckSummary,
} from '../../core/ports/receipt-store.port';
import { JsonReceiptStore } from './json-receipt.store';

describe('JsonReceiptStore', () => {
  let projectRoot: string;
  let store: JsonReceiptStore;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'vibecache-receipt-'));
    store = new JsonReceiptStore();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('atomically writes and reads a schema-versioned receipt', async () => {
    const receipt = featureReceipt();

    await store.write(projectRoot, receipt);

    await expect(store.read(projectRoot, receipt.featureId)).resolves.toEqual(
      receipt,
    );
    const entries = await readdir(join(projectRoot, '.vibe', 'features'));
    expect(entries).toEqual(['stripe-subscriptions.json']);
    expect(
      JSON.parse(
        await readFile(
          join(projectRoot, '.vibe', 'features', entries[0]),
          'utf8',
        ),
      ),
    ).toEqual(receipt);
  });

  it('is idempotent when the same receipt is written repeatedly', async () => {
    const receipt = featureReceipt();

    await store.write(projectRoot, receipt);
    await store.write(projectRoot, receipt);

    await expect(store.read(projectRoot, receipt.featureId)).resolves.toEqual(
      receipt,
    );
    await expect(
      readdir(join(projectRoot, '.vibe', 'features')),
    ).resolves.toEqual(['stripe-subscriptions.json']);
  });

  it('returns null when a receipt has not been installed', async () => {
    await expect(
      store.read(projectRoot, 'stripe-subscriptions'),
    ).resolves.toBeNull();
  });

  it('rejects failed verification without creating an installed receipt', async () => {
    const receipt = featureReceipt() as unknown as Record<string, unknown>;
    receipt.verification = {
      status: 'failed',
      verifiedAt: new Date().toISOString(),
      checks: [],
    };

    await expect(
      store.write(projectRoot, receipt as unknown as FeatureReceipt),
    ).rejects.toThrow('requires passed verification');
    await expect(
      store.read(projectRoot, 'stripe-subscriptions'),
    ).resolves.toBeNull();
  });

  it.each([
    '',
    '.',
    '..',
    '../outside',
    'nested/feature',
    'nested\\feature',
    '/absolute',
    'UPPERCASE',
    'encoded%2fpath',
  ])('rejects unsafe feature id %p', async (featureId) => {
    await expect(store.read(projectRoot, featureId)).rejects.toThrow(
      'Feature id',
    );
  });

  it('rejects a receipt whose embedded feature id differs from its filename', async () => {
    const featuresDirectory = join(projectRoot, '.vibe', 'features');
    await store.write(projectRoot, featureReceipt());
    const path = join(featuresDirectory, 'stripe-subscriptions.json');
    const tampered = featureReceipt();
    tampered.featureId = 'team-invitations';
    await writeFile(path, JSON.stringify(tampered), 'utf8');

    await expect(
      store.read(projectRoot, 'stripe-subscriptions'),
    ).rejects.toThrow('does not match');
  });

  it('rejects a receipt whose capsule id differs from its feature id', async () => {
    const receipt = featureReceipt();
    receipt.capsule.id = 'team-invitations';

    await expect(store.write(projectRoot, receipt)).rejects.toThrow(
      'capsule id must match',
    );
  });

  it('rejects unsupported receipt schema versions', async () => {
    await store.write(projectRoot, featureReceipt());
    const path = join(
      projectRoot,
      '.vibe',
      'features',
      'stripe-subscriptions.json',
    );
    const unsupported = {
      ...featureReceipt(),
      schemaVersion: 99,
    };
    await writeFile(path, JSON.stringify(unsupported), 'utf8');

    await expect(
      store.read(projectRoot, 'stripe-subscriptions'),
    ).rejects.toThrow('Unsupported feature receipt schema version');
  });
});

function featureReceipt(): FeatureReceipt {
  return {
    schemaVersion: FEATURE_RECEIPT_SCHEMA_VERSION,
    featureId: 'stripe-subscriptions',
    status: 'installed',
    capsule: {
      id: 'stripe-subscriptions',
      version: '0.1.0',
      digest: 'sha256:fixture',
    },
    installedAt: '2026-07-21T00:00:00.000Z',
    repositoryFingerprintHash: 'sha256:repository',
    choices: {
      billingPeriods: ['monthly', 'yearly'],
    },
    bindings: {
      databaseSchema: 'prisma/schema.prisma',
    },
    verification: {
      status: 'passed',
      verifiedAt: '2026-07-21T00:00:00.000Z',
      checks: [passedCheck()],
    },
  };
}

function passedCheck(): ReceiptCheckSummary {
  return {
    id: 'build',
    status: 'passed',
    durationMs: 123,
  };
}
