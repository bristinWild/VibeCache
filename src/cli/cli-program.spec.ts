import { resolve } from 'node:path';
import { createCli } from './cli-program';

describe('createCli', () => {
  it('passes a resolved path and parsed answers to the planner', async () => {
    const execute = jest.fn().mockResolvedValue({
      feature: {
        id: 'stripe-subscriptions',
        version: '0.1.0',
        name: 'Stripe subscriptions',
      },
      repository: { path: resolve('test/fixture') },
      status: 'ready',
      waves: [['schema']],
      bindings: [],
      provenance: { memoryIds: [] },
    });
    const output: string[] = [];
    const cli = createCli(
      {
        inspectProject: { execute: jest.fn() },
        planFeature: { execute },
        executeFeature: { execute: jest.fn() },
        registry: { list: jest.fn() },
        runs: { list: jest.fn(), read: jest.fn() },
        confirmation: { confirm: jest.fn() },
      },
      { out: (value) => output.push(value), err: jest.fn() },
    );

    await cli.parseAsync([
      'node',
      'vibe',
      'add',
      'stripe-subscriptions',
      '--path',
      'test/fixture',
      '--dry-run',
      '--answer',
      'cancellation-behavior=immediately',
      '--json',
    ]);

    expect(execute).toHaveBeenCalledWith({
      featureId: 'stripe-subscriptions',
      repositoryPath: resolve('test/fixture'),
      answers: { 'cancellation-behavior': 'immediately' },
    });
    expect(JSON.parse(output.join(''))).toMatchObject({ status: 'ready' });
  });

  it('uses a fresh Commander instance without inherited Cliper commands', () => {
    const cli = createCli({
      inspectProject: { execute: jest.fn() },
      planFeature: { execute: jest.fn() },
      executeFeature: { execute: jest.fn() },
      registry: { list: jest.fn() },
      runs: { list: jest.fn(), read: jest.fn() },
      confirmation: { confirm: jest.fn() },
    });

    expect(cli.commands.map((command) => command.name())).toEqual([
      'runs',
      'run',
      'resume',
      'list',
      'inspect',
      'mcp',
      'marketplace',
      'add',
    ]);
  });

  it('defaults to confirmed Codex execution when no mode flag is provided', async () => {
    const executeFeature = jest.fn().mockResolvedValue({
      status: 'installed',
      run: { runId: 'run-1' },
      receipt: { featureId: 'dark-theme' },
    });
    const confirm = jest.fn().mockResolvedValue(false);
    const cli = createCli(
      {
        inspectProject: { execute: jest.fn() },
        planFeature: { execute: jest.fn().mockResolvedValue(executablePlan()) },
        executeFeature: { execute: executeFeature },
        registry: { list: jest.fn() },
        runs: { list: jest.fn(), read: jest.fn() },
        confirmation: { confirm },
      },
      { out: jest.fn(), err: jest.fn() },
    );

    await cli.parseAsync(['node', 'vibe', 'add', 'dark-theme']);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(executeFeature).not.toHaveBeenCalled();
  });

  it('surfaces unanswered product choices and unresolved repository bindings', async () => {
    const plan = {
      ...executablePlan(),
      status: 'needs-input',
      questions: [
        {
          id: 'billing-period',
          prompt: 'Which billing period?',
          type: 'select',
          options: ['monthly', 'yearly'],
          source: 'unanswered',
        },
      ],
      bindings: [
        {
          target: 'entitlement-service',
          status: 'unresolved',
          evidenceIds: [],
        },
      ],
    };
    const output: string[] = [];
    const cli = createCli(
      {
        inspectProject: { execute: jest.fn() },
        planFeature: { execute: jest.fn().mockResolvedValue(plan) },
        executeFeature: { execute: jest.fn() },
        registry: { list: jest.fn() },
        runs: { list: jest.fn(), read: jest.fn() },
        confirmation: { confirm: jest.fn() },
      },
      { out: (value) => output.push(value), err: jest.fn() },
    );

    await cli.parseAsync([
      'node',
      'vibe',
      'add',
      'stripe-subscriptions',
      '--dry-run',
    ]);

    expect(output.join('')).toContain(
      'pass --answer billing-period=<monthly|yearly>',
    );
    expect(output.join('')).toContain('entitlement-service: unresolved');
  });

  it('requires explicit confirmation before delegating to Codex', async () => {
    const plan = executablePlan();
    const executeFeature = jest.fn().mockResolvedValue({
      status: 'installed',
      run: { runId: 'run-1' },
      receipt: {
        featureId: 'stripe-subscriptions',
        capsule: { version: '0.1.0' },
      },
    });
    const confirm = jest.fn().mockResolvedValue(true);
    const output: string[] = [];
    const cli = createCli(
      {
        inspectProject: { execute: jest.fn() },
        planFeature: { execute: jest.fn().mockResolvedValue(plan) },
        executeFeature: { execute: executeFeature },
        registry: { list: jest.fn() },
        runs: { list: jest.fn(), read: jest.fn() },
        confirmation: { confirm },
      },
      { out: (value) => output.push(value), err: jest.fn() },
    );

    await cli.parseAsync([
      'node',
      'vibe',
      'add',
      'stripe-subscriptions',
      '--path',
      'test/fixture',
      '--agent',
      'codex',
      '--json',
    ]);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(executeFeature).toHaveBeenCalledWith(
      { plan, allowDirty: undefined },
      expect.any(Function),
    );
    expect(JSON.parse(output.join(''))).toMatchObject({ status: 'installed' });
  });

  it('does not start Codex when confirmation is declined', async () => {
    const executeFeature = jest.fn();
    const output: string[] = [];
    const cli = createCli(
      {
        inspectProject: { execute: jest.fn() },
        planFeature: { execute: jest.fn().mockResolvedValue(executablePlan()) },
        executeFeature: { execute: executeFeature },
        registry: { list: jest.fn() },
        runs: { list: jest.fn(), read: jest.fn() },
        confirmation: { confirm: jest.fn().mockResolvedValue(false) },
      },
      { out: (value) => output.push(value), err: jest.fn() },
    );

    await cli.parseAsync([
      'node',
      'vibe',
      'add',
      'stripe-subscriptions',
      '--agent',
      'codex',
    ]);

    expect(executeFeature).not.toHaveBeenCalled();
    expect(output.join('')).toContain('Execution cancelled');
  });

  it('replans from saved choices before resuming a failed run', async () => {
    const savedRun = {
      runId: '20260721t120000000z-abcdef1234567890abcd',
      featureId: 'stripe-subscriptions',
      status: 'failed',
      failure: { recoverable: true },
      nextWave: 2,
      choices: { 'cancellation-behavior': 'immediately' },
    };
    const planned = executablePlan();
    const planFeature = jest.fn().mockResolvedValue(planned);
    const executeFeature = jest.fn().mockResolvedValue({
      status: 'installed',
      run: { runId: savedRun.runId },
      receipt: {
        featureId: 'stripe-subscriptions',
        capsule: { version: '0.1.0' },
      },
    });
    const confirm = jest.fn();
    const cli = createCli(
      {
        inspectProject: { execute: jest.fn() },
        planFeature: { execute: planFeature },
        executeFeature: { execute: executeFeature },
        registry: { list: jest.fn() },
        runs: {
          list: jest.fn(),
          read: jest.fn().mockResolvedValue(savedRun),
        },
        confirmation: { confirm },
      },
      { out: jest.fn(), err: jest.fn() },
    );

    await cli.parseAsync([
      'node',
      'vibe',
      'resume',
      savedRun.runId,
      '--path',
      'test/fixture',
      '--agent',
      'codex',
      '--yes',
      '--json',
    ]);

    expect(planFeature).toHaveBeenCalledWith({
      featureId: 'stripe-subscriptions',
      repositoryPath: resolve('test/fixture'),
      answers: { 'cancellation-behavior': 'immediately' },
    });
    expect(executeFeature).toHaveBeenCalledWith(
      { plan: planned, resumeRun: savedRun },
      expect.any(Function),
    );
    expect(confirm).not.toHaveBeenCalled();
  });
});

function executablePlan() {
  return {
    schemaVersion: 1,
    mode: 'dry-run',
    status: 'ready',
    repository: { path: resolve('test/fixture'), fingerprint: {} },
    feature: {
      id: 'stripe-subscriptions',
      version: '0.1.0',
      name: 'Stripe subscriptions',
      summary: 'Subscriptions',
      provides: ['billing'],
    },
    compatibility: { status: 'compatible' },
    questions: [],
    waves: [['schema']],
    tasks: [
      {
        id: 'schema',
        wave: 1,
        title: 'Schema',
        instructions: ['Implement schema.'],
        dependsOn: [],
        targets: [],
        creates: [],
        verification: [],
      },
    ],
    acceptance: [],
    bindings: [],
    provenance: { source: 'cliper-memory', memoryIds: [] },
  };
}
