import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonReceiptStore } from '../src/adapters/receipts/json-receipt.store';
import { GitRepositoryStateAdapter } from '../src/adapters/git';
import { FilesystemRepositoryIntegrityAdapter } from '../src/adapters/integrity';
import { FilesystemExecutionLeaseAdapter } from '../src/adapters/leases';
import { JsonRunStore } from '../src/adapters/runs';
import { ProcessCheckRunner } from '../src/adapters/verification/process-check.runner';
import type { FeaturePlan } from '../src/core/domain/feature-plan';
import type {
  AgentRunnerPort,
  AgentWaveRunRequest,
  AgentWaveRunResult,
} from '../src/core/ports/agent-runner.port';
import { ExecuteFeatureUseCase } from '../src/core/use-cases/execute-feature.use-case';

jest.setTimeout(15_000);

class FixtureAgent implements AgentRunnerPort {
  readonly requests: AgentWaveRunRequest[] = [];

  runWave(request: AgentWaveRunRequest): Promise<AgentWaveRunResult> {
    this.requests.push(request);
    writeFileSync(
      join(request.repositoryPath, `wave-${request.wave}.txt`),
      `${request.tasks.map(({ id }) => id).join(',')}\n`,
    );
    return Promise.resolve({
      status: 'passed',
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 1,
      finalMessage: `Implemented wave ${request.wave}.`,
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
    });
  }
}

describe('verified feature execution', () => {
  const temporaryRepositories: string[] = [];

  afterEach(() => {
    for (const repository of temporaryRepositories.splice(0)) {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('executes waves, runs real checks, and persists state plus a receipt', async () => {
    const repository = createRepository();
    const agent = new FixtureAgent();
    const runStore = new JsonRunStore();
    const receiptStore = new JsonReceiptStore();
    const executor = new ExecuteFeatureUseCase(
      agent,
      new ProcessCheckRunner({ defaultTimeoutMs: 5_000 }),
      receiptStore,
      runStore,
      new GitRepositoryStateAdapter(),
      new FilesystemRepositoryIntegrityAdapter(),
      new FilesystemExecutionLeaseAdapter(),
    );

    const result = await executor.execute({ plan: executionPlan(repository) });

    expect(result.status).toBe('installed');
    if (result.status !== 'installed') throw new Error('Expected install.');
    expect(agent.requests.map(({ wave }) => wave)).toEqual([1, 2]);
    expect(readFileSync(join(repository, 'wave-1.txt'), 'utf8')).toBe(
      'schema\n',
    );
    expect(readFileSync(join(repository, 'wave-2.txt'), 'utf8')).toBe(
      'checkout,webhook\n',
    );
    expect(
      existsSync(
        join(repository, '.vibe', 'features', 'test-subscriptions.json'),
      ),
    ).toBe(true);

    const storedRun = await runStore.read(repository, result.run.runId);
    expect(storedRun).toMatchObject({
      status: 'installed',
      waveResults: [
        { wave: 1, status: 'completed' },
        { wave: 2, status: 'completed' },
      ],
    });
    const receipt = await receiptStore.read(repository, 'test-subscriptions');
    expect(receipt?.verification.checks).toHaveLength(4);
  });

  function createRepository(): string {
    const repository = mkdtempSync(join(tmpdir(), 'vibecache-execution-'));
    temporaryRepositories.push(repository);
    writeFileSync(
      join(repository, '.gitignore'),
      '.vibe/runs/\n.vibe/locks/\n',
    );
    writeFileSync(join(repository, 'README.md'), '# Test repository\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repository,
    });
    execFileSync('git', ['config', 'user.name', 'VibeCache Test'], {
      cwd: repository,
    });
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repository });
    return repository;
  }
});

function executionPlan(repositoryPath: string): FeaturePlan {
  const verification = (id: string) => ({
    id,
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 5_000,
  });

  return {
    schemaVersion: 1,
    mode: 'dry-run',
    status: 'ready',
    repository: {
      path: repositoryPath,
      fingerprint: {
        repositoryPath,
        framework: { status: 'unknown', evidenceIds: [] },
        auth: { status: 'unknown', evidenceIds: [] },
        orm: { status: 'unknown', evidenceIds: [] },
        database: { status: 'unknown', evidenceIds: [] },
        deployment: { status: 'unknown', evidenceIds: [] },
        capabilities: [],
      },
    },
    feature: {
      id: 'test-subscriptions',
      version: '0.1.0',
      name: 'Test subscriptions',
      summary: 'Exercise the verified execution pipeline.',
      provides: ['test-billing'],
    },
    compatibility: { status: 'compatible' },
    questions: [],
    bindings: [],
    tasks: [
      {
        id: 'schema',
        wave: 1,
        title: 'Schema',
        instructions: ['Create schema.'],
        dependsOn: [],
        targets: [],
        creates: [],
        verification: [verification('schema-check')],
      },
      {
        id: 'checkout',
        wave: 2,
        title: 'Checkout',
        instructions: ['Create checkout.'],
        dependsOn: ['schema'],
        targets: [],
        creates: [],
        verification: [verification('checkout-check')],
      },
      {
        id: 'webhook',
        wave: 2,
        title: 'Webhook',
        instructions: ['Create webhook.'],
        dependsOn: ['schema'],
        targets: [],
        creates: [],
        verification: [verification('webhook-check')],
      },
    ],
    waves: [['schema'], ['checkout', 'webhook']],
    acceptance: [verification('acceptance-check')],
    provenance: { source: 'cliper-memory', memoryIds: [] },
  };
}
