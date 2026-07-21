import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXECUTION_LEASE_SCHEMA_VERSION,
  type ExecutionLeaseOwner,
} from '../../core/ports/execution-lease.port';
import {
  ExecutionLeaseBusyError,
  ExecutionLeaseOwnershipError,
  ExecutionLeaseStateError,
} from './execution-lease.errors';
import {
  FilesystemExecutionLeaseAdapter,
  type FilesystemExecutionLeaseOptions,
} from './filesystem-execution-lease.adapter';

const HOSTNAME = 'vibecache-test-host';
const FIXED_TIME = new Date('2026-07-21T12:00:00.000Z');

describe('FilesystemExecutionLeaseAdapter', () => {
  let repositoryPath: string;
  const temporaryPaths: string[] = [];

  beforeEach(async () => {
    repositoryPath = await temporaryDirectory('vibecache-lease-repository-');
  });

  afterEach(async () => {
    await Promise.all(
      temporaryPaths
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it('acquires one repository-wide lease atomically and records its owner', async () => {
    const adapter = leaseAdapter({ pid: 1_001, token: token(1) });

    const lease = await adapter.acquire(repositoryPath, 'stripe-subscriptions');

    expect(lease).toMatchObject({
      repositoryPath: await realpath(repositoryPath),
      owner: {
        schemaVersion: EXECUTION_LEASE_SCHEMA_VERSION,
        token: token(1),
        featureId: 'stripe-subscriptions',
        pid: 1_001,
        hostname: HOSTNAME,
        acquiredAt: FIXED_TIME.toISOString(),
      },
    });
    await expect(readOwner(repositoryPath)).resolves.toEqual(lease.owner);
    const leaseStat = await stat(leasePath(repositoryPath));
    expect(leaseStat.mode & 0o777).toBe(0o600);
    expect((await lstat(join(repositoryPath, '.vibe'))).isSymbolicLink()).toBe(
      false,
    );

    await lease.release();
  });

  it('rejects another feature with a typed busy error while the owner is live', async () => {
    const ownerAdapter = leaseAdapter({ pid: 1_101, token: token(2) });
    const contender = leaseAdapter({
      pid: 1_102,
      token: token(3),
      isProcessAlive: (pid) => pid === 1_101,
    });
    const ownerLease = await ownerAdapter.acquire(
      repositoryPath,
      'stripe-subscriptions',
    );

    await expect(
      contender.acquire(repositoryPath, 'email-notifications'),
    ).rejects.toMatchObject<Partial<ExecutionLeaseBusyError>>({
      code: 'EXECUTION_LEASE_BUSY',
      reason: 'live-local-owner',
      owner: ownerLease.owner,
    });

    await ownerLease.release();
  });

  it('allows exactly one winner when initially acquired concurrently', async () => {
    const first = leaseAdapter({
      pid: 1_201,
      token: token(4),
      isProcessAlive: () => true,
    });
    const second = leaseAdapter({
      pid: 1_202,
      token: token(5),
      isProcessAlive: () => true,
    });

    const outcomes = await Promise.allSettled([
      first.acquire(repositoryPath, 'first-feature'),
      second.acquire(repositoryPath, 'second-feature'),
    ]);
    const fulfilled = outcomes.filter(
      (
        outcome,
      ): outcome is PromiseFulfilledResult<
        Awaited<ReturnType<typeof first.acquire>>
      > => outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ExecutionLeaseBusyError);
    await fulfilled[0].value.release();
  });

  it('releases idempotently, including concurrent release calls', async () => {
    const first = leaseAdapter({ pid: 1_301, token: token(6) });
    const lease = await first.acquire(repositoryPath, 'first-feature');

    await Promise.all([lease.release(), lease.release(), lease.release()]);
    await expect(lstat(leasePath(repositoryPath))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const second = leaseAdapter({ pid: 1_302, token: token(7) });
    const replacement = await second.acquire(repositoryPath, 'second-feature');
    expect(replacement.owner.token).toBe(token(7));
    await replacement.release();
  });

  it('reclaims a clearly dead local PID owner', async () => {
    const originalAdapter = leaseAdapter({ pid: 1_401, token: token(8) });
    const original = await originalAdapter.acquire(
      repositoryPath,
      'first-feature',
    );
    const recoveringAdapter = leaseAdapter({
      pid: 1_402,
      token: token(9),
      isProcessAlive: (pid) => pid !== 1_401,
    });

    const recovered = await recoveringAdapter.acquire(
      repositoryPath,
      'second-feature',
    );

    expect(await readOwner(repositoryPath)).toEqual(recovered.owner);
    await expect(original.release()).rejects.toBeInstanceOf(
      ExecutionLeaseOwnershipError,
    );
    expect(await readOwner(repositoryPath)).toEqual(recovered.owner);
    await recovered.release();
  });

  it('allows only one contender to reclaim the same dead owner', async () => {
    const original = await leaseAdapter({
      pid: 1_501,
      token: token(10),
    }).acquire(repositoryPath, 'original-feature');
    const aliveUnlessOriginal = (pid: number) => pid !== 1_501;
    const first = leaseAdapter({
      pid: 1_502,
      token: token(11),
      isProcessAlive: aliveUnlessOriginal,
    });
    const second = leaseAdapter({
      pid: 1_503,
      token: token(12),
      isProcessAlive: aliveUnlessOriginal,
    });

    const outcomes = await Promise.allSettled([
      first.acquire(repositoryPath, 'first-recovery'),
      second.acquire(repositoryPath, 'second-recovery'),
    ]);
    const winners = outcomes.filter(
      (
        outcome,
      ): outcome is PromiseFulfilledResult<
        Awaited<ReturnType<typeof first.acquire>>
      > => outcome.status === 'fulfilled',
    );

    expect(winners).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    await expect(original.release()).rejects.toBeInstanceOf(
      ExecutionLeaseOwnershipError,
    );
    await winners[0].value.release();
  });

  it('does not reclaim an owner from another host', async () => {
    const owner = await leaseAdapter({
      pid: 1_601,
      token: token(13),
      hostname: 'other-host',
    }).acquire(repositoryPath, 'remote-feature');
    const processInspector = jest.fn(() => false);
    const contender = leaseAdapter({
      pid: 1_602,
      token: token(14),
      isProcessAlive: processInspector,
    });

    await expect(
      contender.acquire(repositoryPath, 'local-feature'),
    ).rejects.toMatchObject<Partial<ExecutionLeaseBusyError>>({
      code: 'EXECUTION_LEASE_BUSY',
      reason: 'foreign-owner',
    });
    expect(processInspector).not.toHaveBeenCalled();
    await owner.release();
  });

  it('refuses to release a replacement owner even with an old handle', async () => {
    const adapter = leaseAdapter({ pid: 1_701, token: token(15) });
    const original = await adapter.acquire(repositoryPath, 'original-feature');
    await unlink(leasePath(repositoryPath));
    const replacement = ownerRecord({
      token: token(16),
      featureId: 'replacement-feature',
      pid: 1_702,
    });
    await writeOwner(repositoryPath, replacement);

    await expect(original.release()).rejects.toMatchObject<
      Partial<ExecutionLeaseOwnershipError>
    >({
      code: 'EXECUTION_LEASE_OWNERSHIP_LOST',
      expectedToken: token(15),
      actualOwner: replacement,
    });
    await expect(readOwner(repositoryPath)).resolves.toEqual(replacement);
  });

  it.each([
    '',
    '.',
    '..',
    '../outside',
    'nested/feature',
    'nested\\feature',
    '/absolute',
    'Uppercase',
  ])(
    'rejects unsafe feature id %p without creating lease state',
    async (id) => {
      await expect(
        leaseAdapter({ pid: 1_801, token: token(17) }).acquire(
          repositoryPath,
          id,
        ),
      ).rejects.toMatchObject<Partial<ExecutionLeaseStateError>>({
        code: 'INVALID_FEATURE_ID',
      });
      await expect(lstat(join(repositoryPath, '.vibe'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it('rejects symbolic-link lease directories without writing outside the repository', async () => {
    const outside = await temporaryDirectory('vibecache-lease-outside-');
    await symlink(outside, join(repositoryPath, '.vibe'));

    await expect(
      leaseAdapter({ pid: 1_901, token: token(18) }).acquire(
        repositoryPath,
        'safe-feature',
      ),
    ).rejects.toMatchObject<Partial<ExecutionLeaseStateError>>({
      code: 'UNSAFE_LEASE_PATH',
    });
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it('rejects a symbolic-link locks directory without writing through it', async () => {
    const outside = await temporaryDirectory('vibecache-lease-outside-');
    await mkdir(join(repositoryPath, '.vibe'));
    await symlink(outside, join(repositoryPath, '.vibe', 'locks'));

    await expect(
      leaseAdapter({ pid: 1_951, token: token(181) }).acquire(
        repositoryPath,
        'safe-feature',
      ),
    ).rejects.toMatchObject<Partial<ExecutionLeaseStateError>>({
      code: 'UNSAFE_LEASE_PATH',
    });
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it('rejects a symbolic-link lock file without touching its target', async () => {
    const outside = await temporaryDirectory('vibecache-lease-outside-');
    const target = join(outside, 'target.json');
    await writeFile(target, 'do-not-touch', 'utf8');
    await mkdir(join(repositoryPath, '.vibe'));
    await mkdir(join(repositoryPath, '.vibe', 'locks'));
    await symlink(target, leasePath(repositoryPath));

    await expect(
      leaseAdapter({ pid: 2_001, token: token(19) }).acquire(
        repositoryPath,
        'safe-feature',
      ),
    ).rejects.toMatchObject<Partial<ExecutionLeaseStateError>>({
      code: 'UNSAFE_LEASE_PATH',
    });
    await expect(readFile(target, 'utf8')).resolves.toBe('do-not-touch');
  });

  it('leaves malformed ownership records untouched', async () => {
    await mkdir(join(repositoryPath, '.vibe'));
    await mkdir(join(repositoryPath, '.vibe', 'locks'));
    await writeFile(leasePath(repositoryPath), '{invalid', 'utf8');

    await expect(
      leaseAdapter({ pid: 2_101, token: token(20) }).acquire(
        repositoryPath,
        'safe-feature',
      ),
    ).rejects.toMatchObject<Partial<ExecutionLeaseStateError>>({
      code: 'INVALID_LEASE_RECORD',
    });
    await expect(readFile(leasePath(repositoryPath), 'utf8')).resolves.toBe(
      '{invalid',
    );
  });

  it('leaves oversized ownership records untouched', async () => {
    await mkdir(join(repositoryPath, '.vibe'));
    await mkdir(join(repositoryPath, '.vibe', 'locks'));
    const oversized = 'x'.repeat(8 * 1024 + 1);
    await writeFile(leasePath(repositoryPath), oversized, 'utf8');

    await expect(
      leaseAdapter({ pid: 2_201, token: token(21) }).acquire(
        repositoryPath,
        'safe-feature',
      ),
    ).rejects.toMatchObject<Partial<ExecutionLeaseStateError>>({
      code: 'INVALID_LEASE_RECORD',
    });
    expect((await stat(leasePath(repositoryPath))).size).toBe(
      Buffer.byteLength(oversized),
    );
  });

  function temporaryDirectory(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), prefix)).then((path) => {
      temporaryPaths.push(path);
      return path;
    });
  }
});

function leaseAdapter(options: {
  pid: number;
  token: string;
  hostname?: string;
  isProcessAlive?: (pid: number) => boolean;
}): FilesystemExecutionLeaseAdapter {
  const adapterOptions: FilesystemExecutionLeaseOptions = {
    pid: options.pid,
    hostname: options.hostname ?? HOSTNAME,
    now: () => new Date(FIXED_TIME),
    tokenFactory: () => options.token,
    isProcessAlive: options.isProcessAlive ?? (() => true),
  };
  return new FilesystemExecutionLeaseAdapter(adapterOptions);
}

function token(suffix: number): string {
  return `00000000-0000-4000-8000-${suffix.toString(16).padStart(12, '0')}`;
}

function leasePath(repositoryPath: string): string {
  return join(repositoryPath, '.vibe', 'locks', 'execution.lock');
}

async function readOwner(repositoryPath: string): Promise<ExecutionLeaseOwner> {
  return JSON.parse(
    await readFile(leasePath(repositoryPath), 'utf8'),
  ) as ExecutionLeaseOwner;
}

async function writeOwner(
  repositoryPath: string,
  owner: ExecutionLeaseOwner,
): Promise<void> {
  await writeFile(
    leasePath(repositoryPath),
    `${JSON.stringify(owner, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
}

function ownerRecord(
  input: Pick<ExecutionLeaseOwner, 'token' | 'featureId' | 'pid'>,
): ExecutionLeaseOwner {
  return {
    schemaVersion: EXECUTION_LEASE_SCHEMA_VERSION,
    ...input,
    hostname: HOSTNAME,
    acquiredAt: FIXED_TIME.toISOString(),
  };
}
