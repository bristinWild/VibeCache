import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessCheckRunner } from './process-check.runner';
import { verificationEnvironment } from './process-check.runner';

describe('ProcessCheckRunner', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'vibecache-check-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('passes arguments literally without invoking a shell', async () => {
    const runner = new ProcessCheckRunner();
    const literalArgs = ['hello; exit 9', '$(echo unsafe)', 'two words'];

    const result = await runner.run({
      id: 'literal-arguments',
      executable: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
        ...literalArgs,
      ],
      cwd,
    });

    expect(result.status).toBe('passed');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(literalArgs);
    expect(result.stderr).toBe('');
  });

  it('does not inherit arbitrary secret-bearing environment variables', async () => {
    const runner = new ProcessCheckRunner();
    const secretName = 'VIBECACHE_TEST_SECRET';
    process.env[secretName] = 'must-not-leak';
    try {
      const result = await runner.run({
        id: 'sanitized-environment',
        executable: process.execPath,
        args: ['-e', `process.stdout.write(String(process.env.${secretName}))`],
        cwd,
      });

      expect(result.status).toBe('passed');
      expect(result.stdout).toBe('undefined');
    } finally {
      delete process.env[secretName];
    }
  });

  it('keeps only the documented process bootstrap environment', () => {
    expect(
      verificationEnvironment({ PATH: '/bin', API_TOKEN: 'secret' }),
    ).toEqual({ PATH: '/bin' });
  });

  it('returns non-zero exit diagnostics', async () => {
    const runner = new ProcessCheckRunner();

    const result = await runner.run({
      id: 'failure',
      executable: process.execPath,
      args: ['-e', "process.stderr.write('broken'); process.exit(7)"],
      cwd,
    });

    expect(result).toMatchObject({
      id: 'failure',
      status: 'failed',
      exitCode: 7,
      timedOut: false,
      stdout: '',
      stderr: 'broken',
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('terminates checks that exceed their timeout', async () => {
    const runner = new ProcessCheckRunner({ killGraceMs: 25 });

    const result = await runner.run({
      id: 'timeout',
      executable: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1_000)'],
      cwd,
      timeoutMs: 30,
    });

    expect(result.status).toBe('timed_out');
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).not.toBeNull();
  });

  it('terminates a check when the execution signal is aborted', async () => {
    const runner = new ProcessCheckRunner({ killGraceMs: 25 });
    const controller = new AbortController();
    const running = runner.run({
      id: 'aborted',
      executable: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1_000)'],
      cwd,
      timeoutMs: 5_000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 30);
    const result = await running;

    expect(result).toMatchObject({
      status: 'error',
      timedOut: false,
      error: 'Verification was interrupted.',
    });
  });

  it('rejects invalid timeout configuration', async () => {
    const runner = new ProcessCheckRunner();

    await expect(
      runner.run({
        id: 'invalid-timeout',
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd,
        timeoutMs: 0,
      }),
    ).rejects.toThrow('timeoutMs must be a positive integer');
  });

  it('bounds stdout and stderr while recording their total sizes', async () => {
    const runner = new ProcessCheckRunner({ maxOutputBytes: 64 });

    const result = await runner.run({
      id: 'bounded-output',
      executable: process.execPath,
      args: [
        '-e',
        "process.stdout.write('o'.repeat(2048)); process.stderr.write('e'.repeat(1024))",
      ],
      cwd,
    });

    expect(result.status).toBe('passed');
    expect(result.stdout).toHaveLength(64);
    expect(result.stderr).toHaveLength(64);
    expect(result).toMatchObject({
      stdoutBytes: 2048,
      stderrBytes: 1024,
      stdoutCapturedBytes: 64,
      stderrCapturedBytes: 64,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
  });

  it('reports spawn errors and aggregates all check results', async () => {
    const runner = new ProcessCheckRunner();

    const result = await runner.runAll([
      {
        id: 'pass',
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd,
      },
      {
        id: 'missing-executable',
        executable: join(cwd, 'does-not-exist'),
        args: [],
        cwd,
      },
    ]);

    expect(result.status).toBe('failed');
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0].status).toBe('passed');
    expect(result.checks[1]).toMatchObject({
      status: 'error',
      exitCode: -2,
    });
    expect(result.checks[1].error).toContain('ENOENT');
  });
});
