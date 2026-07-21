import type { FeaturePlan } from '../domain/feature-plan';
import { parseFeatureRun, type FeatureRun } from '../domain/feature-run';
import type {
  AgentRunnerPort,
  AgentWaveRunRequest,
  AgentWaveRunResult,
} from '../ports/agent-runner.port';
import type {
  CheckResult,
  CheckRunnerPort,
  PassedCheckResult,
  VerificationCheck,
  VerificationRunResult,
} from '../ports/check-runner.port';
import type {
  FeatureReceipt,
  ReceiptStorePort,
} from '../ports/receipt-store.port';
import type {
  RepositoryStatePort,
  RepositoryStateSnapshot,
} from '../ports/repository-state.port';
import type { RepositoryIntegrityPort } from '../ports/repository-integrity.port';
import type { ExecutionLeasePort } from '../ports/execution-lease.port';
import type { RunStorePort } from '../ports/run-store.port';
import { stableDigest } from '../services/stable-digest';
import {
  ExecuteFeatureUseCase,
  FeatureExecutionError,
  type FeatureExecutionEvent,
} from './execute-feature.use-case';

describe('ExecuteFeatureUseCase', () => {
  it('runs waves in order, verifies each boundary, and writes a final receipt', async () => {
    const harness = createHarness();
    const events: FeatureExecutionEvent[] = [];

    const result = await harness.useCase.execute(plan(), (event) =>
      events.push(event),
    );

    expect(result.status).toBe('installed');
    expect(harness.agentRequests.map(({ wave }) => wave)).toEqual([1, 2]);
    expect(harness.agentRequests[0].tasks.map(({ id }) => id)).toEqual([
      'schema',
    ]);
    expect(harness.agentRequests[1].tasks.map(({ id }) => id)).toEqual([
      'checkout',
      'webhook',
    ]);
    expect(
      harness.checkBatches.map((batch) => batch.map(({ id }) => id)),
    ).toEqual([
      ['schema-check'],
      ['checkout-check', 'webhook-check'],
      ['acceptance-check'],
    ]);
    expect(harness.receipts).toHaveLength(1);
    expect(harness.receipts[0]).toMatchObject({
      featureId: 'stripe-subscriptions',
      status: 'installed',
      choices: { 'cancellation-behavior': 'end-of-period' },
      bindings: { 'database-schema': 'prisma/schema.prisma' },
      verification: { status: 'passed' },
    });
    expect(harness.receipts[0].verification.checks).toHaveLength(4);
    expect(harness.runs.at(-1)).toMatchObject({
      status: 'installed',
      currentWave: null,
      nextWave: null,
    });
    expect(harness.leaseAcquire).toHaveBeenCalledWith(
      '/project',
      'stripe-subscriptions',
    );
    expect(harness.leaseRelease).toHaveBeenCalledTimes(1);
    expect(events.map(({ type }) => type)).toEqual([
      'run-started',
      'wave-started',
      'agent-finished',
      'verification-finished',
      'wave-started',
      'agent-finished',
      'verification-finished',
      'verification-finished',
      'run-finished',
    ]);
  });

  it('stops immediately and preserves resumable state when Codex fails', async () => {
    const harness = createHarness({
      agentResults: [agentResult('failed', 'Codex process failed')],
    });

    const result = await harness.useCase.execute(plan());

    expect(result).toMatchObject({
      status: 'failed',
      run: {
        status: 'failed',
        currentWave: 1,
        nextWave: 1,
        failure: { code: 'agent-failed', recoverable: true, wave: 1 },
        waveResults: [
          {
            wave: 1,
            status: 'failed',
            verification: { status: 'skipped' },
          },
        ],
      },
    });
    expect(harness.checkBatches).toHaveLength(0);
    expect(harness.receipts).toHaveLength(0);
  });

  it('does not start the next wave or write a receipt after failed verification', async () => {
    const harness = createHarness({ failedCheckBatch: 1 });

    const result = await harness.useCase.execute(plan());

    expect(result).toMatchObject({
      status: 'failed',
      run: {
        failure: { code: 'verification-failed', wave: 1 },
        nextWave: 1,
      },
    });
    expect(harness.agentRequests).toHaveLength(1);
    expect(harness.checkBatches).toHaveLength(1);
    expect(harness.receipts).toHaveLength(0);
  });

  it('resumes the failed wave with the same run id', async () => {
    const harness = createHarness({
      agentResults: [
        agentResult('failed', 'temporary agent failure'),
        agentResult('passed'),
        agentResult('passed'),
      ],
    });
    const failed = await harness.useCase.execute(plan());
    if (failed.status !== 'failed') throw new Error('Expected failed run.');
    const events: FeatureExecutionEvent[] = [];

    const resumed = await harness.useCase.execute(
      { plan: plan().plan, resumeRun: failed.run },
      (event) => events.push(event),
    );

    expect(resumed.status).toBe('installed');
    if (resumed.status !== 'installed') throw new Error('Expected install.');
    expect(resumed.run.runId).toBe(failed.run.runId);
    expect(harness.agentRequests.map(({ wave }) => wave)).toEqual([1, 1, 2]);
    expect(events[0]).toMatchObject({
      type: 'run-resumed',
      runId: failed.run.runId,
      nextWave: 1,
    });
  });

  it('recovers a run left running by an interrupted process', async () => {
    const firstHarness = createHarness({
      agentResults: [agentResult('failed', 'simulated interruption')],
    });
    const failed = await firstHarness.useCase.execute(plan());
    if (failed.status !== 'failed') throw new Error('Expected failed run.');
    const timestamps = { ...failed.run.timestamps };
    delete timestamps.completedAt;
    const interrupted: FeatureRun = {
      ...failed.run,
      status: 'running',
      failure: undefined,
      timestamps,
    };
    const recoveryHarness = createHarness();

    const recovered = await recoveryHarness.useCase.execute({
      plan: plan().plan,
      resumeRun: interrupted,
    });

    expect(recovered.status).toBe('installed');
    if (recovered.status !== 'installed') throw new Error('Expected install.');
    expect(recovered.run.runId).toBe(interrupted.runId);
    expect(recoveryHarness.agentRequests.map(({ wave }) => wave)).toEqual([
      1, 2,
    ]);
  });

  it('re-verifies completed waves before resuming a later wave', async () => {
    const harness = createHarness({ failedCheckBatch: 2 });
    const failed = await harness.useCase.execute(plan());
    if (failed.status !== 'failed') throw new Error('Expected failed run.');

    const resumed = await harness.useCase.execute({
      plan: plan().plan,
      resumeRun: failed.run,
    });

    expect(resumed.status).toBe('installed');
    expect(harness.agentRequests.map(({ wave }) => wave)).toEqual([1, 2, 2]);
    expect(
      harness.checkBatches.map((batch) => batch.map(({ id }) => id)),
    ).toEqual([
      ['schema-check'],
      ['checkout-check', 'webhook-check'],
      ['schema-check'],
      ['checkout-check', 'webhook-check'],
      ['acceptance-check'],
    ]);
  });

  it('refuses resume after repository HEAD drifts', async () => {
    const harness = createHarness({
      agentResults: [agentResult('failed', 'temporary agent failure')],
    });
    const failed = await harness.useCase.execute(plan());
    if (failed.status !== 'failed') throw new Error('Expected failed run.');
    const drifted: FeatureRun = {
      ...failed.run,
      repository: {
        ...failed.run.repository,
        startingCommit: 'b'.repeat(40),
      },
    };

    await expect(
      harness.useCase.execute({ plan: plan().plan, resumeRun: drifted }),
    ).rejects.toMatchObject<Partial<FeatureExecutionError>>({
      code: 'REPOSITORY_DRIFT',
    });
  });

  it('refuses resume when fresh Cliper memory changes a saved binding', async () => {
    const harness = createHarness({
      agentResults: [agentResult('failed', 'temporary agent failure')],
    });
    const failed = await harness.useCase.execute(plan());
    if (failed.status !== 'failed') throw new Error('Expected failed run.');
    const replanned: FeaturePlan = {
      ...plan().plan,
      bindings: [
        {
          target: 'database-schema',
          status: 'resolved',
          path: 'packages/data/prisma/schema.prisma',
          evidenceIds: ['new-schema-memory'],
        },
      ],
    };

    await expect(
      harness.useCase.execute({ plan: replanned, resumeRun: failed.run }),
    ).rejects.toMatchObject<Partial<FeatureExecutionError>>({
      code: 'RUN_PLAN_MISMATCH',
    });
    expect(harness.agentRequests).toHaveLength(1);
  });

  it('fails safely if Codex changes Git HEAD', async () => {
    const harness = createHarness({
      inspectedRepository: {
        targetPath: '/project',
        isInsideWorkTree: true,
        repositoryRoot: '/project',
        headCommit: 'b'.repeat(40),
        statusEntries: [],
        isClean: true,
      },
    });

    const result = await harness.useCase.execute(plan());

    expect(result).toMatchObject({
      status: 'failed',
      run: {
        failure: {
          code: 'execution-error',
          recoverable: false,
        },
      },
    });
    if (result.status !== 'failed') throw new Error('Expected failure.');
    expect(result.run.failure?.message).toContain('changed repository HEAD');
    expect(harness.checkBatches).toHaveLength(0);
    expect(harness.receipts).toHaveLength(0);
  });

  it('fails safely if Codex changes generated Cliper memory', async () => {
    const harness = createHarness({
      inspectedRepository: {
        targetPath: '/project',
        isInsideWorkTree: true,
        repositoryRoot: '/project',
        headCommit: 'a'.repeat(40),
        statusEntries: [
          {
            indexStatus: ' ',
            workTreeStatus: 'M',
            path: '.cliper/memory/generated.json',
          },
        ],
        isClean: false,
      },
    });

    const result = await harness.useCase.execute(plan());

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected failure.');
    expect(result.run.failure).toMatchObject({
      code: 'execution-error',
      recoverable: false,
    });
    expect(result.run.failure?.message).toContain('Cliper memory');
    expect(harness.checkBatches).toHaveLength(0);
    expect(harness.receipts).toHaveLength(0);
  });

  it('detects protected path changes even when Git status does not expose them', async () => {
    const harness = createHarness({
      protectedDigests: ['before-agent', 'after-agent'],
    });

    const result = await harness.useCase.execute(plan());

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected failure.');
    expect(result.run.failure).toMatchObject({
      code: 'execution-error',
      recoverable: false,
    });
    expect(result.run.failure?.message).toContain('protected .cliper or .vibe');
    expect(harness.checkBatches).toHaveLength(0);
    expect(harness.receipts).toHaveLength(0);
  });

  it('detects a verification command that changes Git HEAD', async () => {
    const harness = createHarness({
      inspectedRepositories: [
        repositoryStateSnapshot(),
        repositoryStateSnapshot('b'.repeat(40)),
      ],
    });

    const result = await harness.useCase.execute(plan());

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected failure.');
    expect(result.run.failure?.message).toContain('changed repository HEAD');
    expect(harness.agentRequests).toHaveLength(1);
    expect(harness.receipts).toHaveLength(0);
  });

  it('does not let a throwing progress observer corrupt execution state', async () => {
    const harness = createHarness();

    const result = await harness.useCase.execute(plan(), () => {
      throw new Error('observer transport failed');
    });

    expect(result.status).toBe('installed');
    expect(harness.receipts).toHaveLength(1);
    expect(harness.runs.at(-1)?.status).toBe('installed');
  });

  it('is idempotent when the same capsule version already has a receipt', async () => {
    const existing = installedReceipt();
    const harness = createHarness({ existingReceipt: existing });

    await expect(harness.useCase.execute(plan())).resolves.toEqual({
      status: 'already-installed',
      receipt: existing,
    });
    expect(harness.agentRequests).toHaveLength(0);
    expect(harness.runs).toHaveLength(0);
    expect(harness.leaseRelease).toHaveBeenCalledTimes(1);
  });

  it('rejects a same-version receipt for a different capsule plan', async () => {
    const existing = installedReceipt();
    existing.capsule.digest = 'different-plan';
    const harness = createHarness({ existingReceipt: existing });

    await expect(harness.useCase.execute(plan())).rejects.toMatchObject<
      Partial<FeatureExecutionError>
    >({ code: 'CAPSULE_VERSION_CONFLICT' });
    expect(harness.agentRequests).toHaveLength(0);
  });

  it('treats the receipt as the commit point if final run-history persistence fails', async () => {
    const harness = createHarness({ failedRunWriteAt: 6 });

    const result = await harness.useCase.execute(plan());

    expect(result.status).toBe('installed');
    expect(harness.receipts).toHaveLength(1);
    expect(harness.runs.at(-1)?.status).toBe('running');

    const interrupted = harness.runs.at(-1);
    if (!interrupted) throw new Error('Expected interrupted run state.');
    const reconciled = await harness.useCase.execute({
      plan: plan().plan,
      resumeRun: interrupted,
    });

    expect(reconciled.status).toBe('already-installed');
    expect(harness.runs.at(-1)?.status).toBe('installed');
  });

  it('rejects a non-ready plan before any repository mutation', async () => {
    const harness = createHarness();
    const notReady = { ...plan().plan, status: 'needs-input' as const };

    await expect(
      harness.useCase.execute({ plan: notReady }),
    ).rejects.toMatchObject<Partial<FeatureExecutionError>>({
      code: 'PLAN_NOT_READY',
    });
    expect(harness.agentRequests).toHaveLength(0);
    expect(harness.runs).toHaveLength(0);
    expect(harness.leaseAcquire).not.toHaveBeenCalled();
  });
});

function plan(): { plan: FeaturePlan; allowDirty?: boolean } {
  return {
    plan: {
      schemaVersion: 1,
      mode: 'dry-run',
      status: 'ready',
      repository: {
        path: '/project',
        fingerprint: {
          repositoryPath: '/project',
          framework: {
            status: 'detected',
            value: 'nextjs-app-router',
            evidenceIds: ['repository'],
          },
          auth: {
            status: 'detected',
            value: 'supabase',
            evidenceIds: ['repository'],
          },
          orm: {
            status: 'detected',
            value: 'prisma',
            evidenceIds: ['repository'],
          },
          database: {
            status: 'detected',
            value: 'postgres',
            evidenceIds: ['repository'],
          },
          deployment: { status: 'unknown', evidenceIds: [] },
          capabilities: [],
        },
      },
      feature: {
        id: 'stripe-subscriptions',
        version: '0.1.0',
        name: 'Stripe subscriptions',
        summary: 'Adds recurring billing.',
        provides: ['subscription-billing'],
      },
      compatibility: { status: 'compatible' },
      questions: [
        {
          id: 'cancellation-behavior',
          prompt: 'When should access end?',
          type: 'select',
          options: ['end-of-period', 'immediately'],
          answer: 'end-of-period',
          source: 'default',
        },
      ],
      bindings: [
        {
          target: 'database-schema',
          status: 'resolved',
          path: 'prisma/schema.prisma',
          evidenceIds: ['schema-memory'],
        },
        {
          target: 'acceptance-tests',
          status: 'unresolved',
          evidenceIds: [],
        },
      ],
      tasks: [
        task('schema', 1, [], ['schema-check']),
        task('checkout', 2, ['schema'], ['checkout-check']),
        task('webhook', 2, ['schema'], ['webhook-check']),
      ],
      waves: [['schema'], ['checkout', 'webhook']],
      acceptance: [checkDefinition('acceptance-check')],
      provenance: { source: 'cliper-memory', memoryIds: ['repository'] },
    },
  };
}

function task(
  id: string,
  wave: number,
  dependsOn: string[],
  checks: string[],
): FeaturePlan['tasks'][number] {
  return {
    id,
    wave,
    title: id,
    instructions: [`Implement ${id}.`],
    dependsOn,
    targets: ['database-schema'],
    creates: [],
    verification: checks.map(checkDefinition),
  };
}

function checkDefinition(id: string) {
  return { id, executable: 'node', args: ['--version'], timeoutMs: 1_000 };
}

interface HarnessOptions {
  agentResults?: AgentWaveRunResult[];
  failedCheckBatch?: number;
  existingReceipt?: FeatureReceipt;
  inspectedRepository?: RepositoryStateSnapshot;
  inspectedRepositories?: RepositoryStateSnapshot[];
  protectedDigests?: string[];
  failedRunWriteAt?: number;
}

function createHarness(options: HarnessOptions = {}) {
  const agentRequests: AgentWaveRunRequest[] = [];
  const checkBatches: VerificationCheck[][] = [];
  const receipts: FeatureReceipt[] = [];
  const runs: FeatureRun[] = [];
  const queuedAgentResults = [...(options.agentResults ?? [])];
  const protectedDigests = [...(options.protectedDigests ?? [])];
  const inspectedRepositories = [...(options.inspectedRepositories ?? [])];
  const leaseRelease = jest.fn().mockResolvedValue(undefined);
  const leaseAcquire = jest.fn((_repositoryPath: string, featureId: string) =>
    Promise.resolve({
      repositoryPath: '/project',
      owner: {
        schemaVersion: 1 as const,
        token: '00000000-0000-4000-8000-000000000000',
        featureId,
        pid: process.pid,
        hostname: 'test-host',
        acquiredAt: new Date().toISOString(),
      },
      release: leaseRelease,
    }),
  );
  let runWriteCount = 0;

  const agentRunner: AgentRunnerPort = {
    runWave: (request) => {
      agentRequests.push(request);
      return Promise.resolve(
        queuedAgentResults.shift() ?? agentResult('passed'),
      );
    },
  };
  const checkRunner: CheckRunnerPort = {
    run: (check) => Promise.resolve(passedCheck(check)),
    runAll: (checks) => {
      checkBatches.push(checks);
      const batch = checkBatches.length;
      if (batch === options.failedCheckBatch) {
        return Promise.resolve({
          status: 'failed' as const,
          checks: checks.map((check) => failedCheck(check)),
        } satisfies VerificationRunResult);
      }
      return Promise.resolve({
        status: 'passed' as const,
        checks: checks.map(passedCheck),
      } satisfies VerificationRunResult);
    },
  };
  const receiptStore: ReceiptStorePort = {
    read: () =>
      Promise.resolve(options.existingReceipt ?? receipts.at(-1) ?? null),
    write: (_root, receipt) => {
      receipts.push(receipt);
      return Promise.resolve();
    },
  };
  const runStore: RunStorePort = {
    list: () => Promise.resolve(runs),
    read: (_root, runId) =>
      Promise.resolve(runs.find((run) => run.runId === runId) ?? null),
    write: (_root, run) => {
      runWriteCount += 1;
      if (runWriteCount === options.failedRunWriteAt) {
        return Promise.reject(new Error('simulated run write failure'));
      }
      const parsed = parseFeatureRun(run);
      runs.push(structuredClone(parsed));
      return Promise.resolve();
    },
  };
  const repositorySnapshot = repositoryStateSnapshot();
  const repositoryState: RepositoryStatePort = {
    inspect: () =>
      Promise.resolve(
        inspectedRepositories.shift() ??
          options.inspectedRepository ??
          repositorySnapshot,
      ),
    assertExecutionReady: () => Promise.resolve(repositorySnapshot),
  };
  const repositoryIntegrity: RepositoryIntegrityPort = {
    snapshotProtectedPaths: () =>
      Promise.resolve({
        algorithm: 'sha256',
        digest: protectedDigests.shift() ?? 'stable-protected-state',
        entryCount: 0,
      }),
  };
  const executionLease: ExecutionLeasePort = {
    acquire: leaseAcquire,
  };

  return {
    useCase: new ExecuteFeatureUseCase(
      agentRunner,
      checkRunner,
      receiptStore,
      runStore,
      repositoryState,
      repositoryIntegrity,
      executionLease,
    ),
    agentRequests,
    checkBatches,
    receipts,
    runs,
    leaseAcquire,
    leaseRelease,
  };
}

function repositoryStateSnapshot(
  headCommit = 'a'.repeat(40),
): RepositoryStateSnapshot {
  return {
    targetPath: '/project',
    isInsideWorkTree: true,
    repositoryRoot: '/project',
    headCommit,
    statusEntries: [],
    isClean: true,
  };
}

function agentResult(
  status: AgentWaveRunResult['status'],
  error?: string,
): AgentWaveRunResult {
  return {
    status,
    exitCode: status === 'passed' ? 0 : 1,
    signal: null,
    timedOut: false,
    durationMs: 10,
    threadId: 'thread-1',
    ...(status === 'passed'
      ? { finalMessage: 'Implemented the wave.' }
      : { error }),
    diagnostics: {
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutCapturedBytes: 0,
      stderrCapturedBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    },
  };
}

function passedCheck(check: VerificationCheck): PassedCheckResult {
  return {
    ...check,
    status: 'passed',
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 5,
    stdout: 'ok',
    stderr: '',
    stdoutBytes: 2,
    stderrBytes: 0,
    stdoutCapturedBytes: 2,
    stderrCapturedBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function failedCheck(check: VerificationCheck): CheckResult {
  return {
    ...passedCheck(check),
    status: 'failed',
    exitCode: 1,
    stdout: '',
    stderr: 'failed',
    stdoutBytes: 0,
    stderrBytes: 6,
    stdoutCapturedBytes: 0,
    stderrCapturedBytes: 6,
  };
}

function installedReceipt(): FeatureReceipt {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    featureId: 'stripe-subscriptions',
    status: 'installed',
    capsule: {
      id: 'stripe-subscriptions',
      version: '0.1.0',
      digest: testPlanDigest(plan().plan),
    },
    installedAt: timestamp,
    verification: { status: 'passed', verifiedAt: timestamp, checks: [] },
  };
}

function testPlanDigest(featurePlan: FeaturePlan): string {
  return stableDigest({
    feature: featurePlan.feature,
    questions: featurePlan.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      type: question.type,
      options: question.options,
      answer: question.answer,
    })),
    bindings: featurePlan.bindings,
    tasks: featurePlan.tasks,
    waves: featurePlan.waves,
    acceptance: featurePlan.acceptance,
  });
}
