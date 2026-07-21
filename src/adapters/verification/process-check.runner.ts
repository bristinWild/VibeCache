import { spawn } from 'node:child_process';
import type {
  CheckResult,
  CheckRunnerPort,
  PassedCheckResult,
  VerificationCheck,
  VerificationRunResult,
} from '../../core/ports/check-runner.port';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_KILL_GRACE_MS = 250;

export interface ProcessCheckRunnerOptions {
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
}

interface CapturedOutput {
  text: string;
  totalBytes: number;
  capturedBytes: number;
  truncated: boolean;
}

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private totalBytes = 0;
  private capturedBytes = 0;

  constructor(private readonly limitBytes: number) {}

  append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.totalBytes += buffer.length;

    const remaining = this.limitBytes - this.capturedBytes;
    if (remaining <= 0) {
      return;
    }

    const captured = buffer.subarray(0, remaining);
    this.chunks.push(captured);
    this.capturedBytes += captured.length;
  }

  result(): CapturedOutput {
    return {
      text: Buffer.concat(this.chunks, this.capturedBytes).toString('utf8'),
      totalBytes: this.totalBytes,
      capturedBytes: this.capturedBytes,
      truncated: this.totalBytes > this.capturedBytes,
    };
  }
}

export class ProcessCheckRunner implements CheckRunnerPort {
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;

  constructor(options: ProcessCheckRunnerOptions = {}) {
    this.defaultTimeoutMs = positiveInteger(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      'defaultTimeoutMs',
    );
    this.maxOutputBytes = positiveInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      'maxOutputBytes',
    );
    this.killGraceMs = nonNegativeInteger(
      options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
      'killGraceMs',
    );
  }

  async run(check: VerificationCheck): Promise<CheckResult> {
    assertCheck(check);

    const timeoutMs =
      check.timeoutMs === undefined
        ? this.defaultTimeoutMs
        : positiveInteger(check.timeoutMs, 'timeoutMs');
    const startedAt = process.hrtime.bigint();
    const stdout = new BoundedOutput(this.maxOutputBytes);
    const stderr = new BoundedOutput(this.maxOutputBytes);

    return new Promise<CheckResult>((resolve) => {
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let spawnError: NodeJS.ErrnoException | undefined;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(check.executable, [...check.args], {
        cwd: check.cwd,
        detached: process.platform !== 'win32',
        env: verificationEnvironment(),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk: Buffer | string) => stdout.append(chunk));
      child.stderr.on('data', (chunk: Buffer | string) => stderr.append(chunk));
      child.once('error', (error: NodeJS.ErrnoException) => {
        spawnError = error;
      });

      const terminate = () => {
        terminateProcessTree(child, 'SIGTERM');
        killTimer ??= setTimeout(() => {
          if (!settled) terminateProcessTree(child, 'SIGKILL');
        }, this.killGraceMs);
      };
      const abortHandler = () => {
        aborted = true;
        terminate();
      };
      check.signal?.addEventListener('abort', abortHandler, { once: true });
      if (check.signal?.aborted) abortHandler();

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);

      child.once('close', (exitCode, signal) => {
        settled = true;
        clearTimeout(timeoutTimer);
        if (killTimer) {
          clearTimeout(killTimer);
        }
        check.signal?.removeEventListener('abort', abortHandler);

        const stdoutResult = stdout.result();
        const stderrResult = stderr.result();
        const status = timedOut
          ? 'timed_out'
          : spawnError || aborted
            ? 'error'
            : exitCode === 0
              ? 'passed'
              : 'failed';

        resolve({
          id: check.id,
          executable: check.executable,
          args: [...check.args],
          cwd: check.cwd,
          status,
          exitCode,
          signal,
          timedOut,
          durationMs: elapsedMilliseconds(startedAt),
          stdout: stdoutResult.text,
          stderr: stderrResult.text,
          stdoutBytes: stdoutResult.totalBytes,
          stderrBytes: stderrResult.totalBytes,
          stdoutCapturedBytes: stdoutResult.capturedBytes,
          stderrCapturedBytes: stderrResult.capturedBytes,
          stdoutTruncated: stdoutResult.truncated,
          stderrTruncated: stderrResult.truncated,
          ...(spawnError
            ? { error: formatError(spawnError) }
            : aborted
              ? { error: 'Verification was interrupted.' }
              : {}),
        });
      });
    });
  }

  async runAll(checks: VerificationCheck[]): Promise<VerificationRunResult> {
    const results: CheckResult[] = [];

    for (const check of checks) {
      results.push(await this.run(check));
    }

    if (results.every(isPassedCheckResult)) {
      return { status: 'passed', checks: results };
    }

    return { status: 'failed', checks: results };
  }
}

const VERIFICATION_ENVIRONMENT_KEYS = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'CI',
  'NO_COLOR',
  'COLORTERM',
] as const;

export function verificationEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    VERIFICATION_ENVIRONMENT_KEYS.flatMap((key) =>
      source[key] === undefined ? [] : [[key, source[key]]],
    ),
  );
}

function terminateProcessTree(
  child: import('node:child_process').ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return;
    }
  }
  child.kill(signal);
}

function assertCheck(check: VerificationCheck): void {
  if (!check.id.trim()) {
    throw new TypeError('Verification check id must not be empty.');
  }
  if (!check.executable.trim()) {
    throw new TypeError('Verification check executable must not be empty.');
  }
  if (!check.cwd.trim()) {
    throw new TypeError('Verification check cwd must not be empty.');
  }
  if (
    !Array.isArray(check.args) ||
    check.args.some((arg) => typeof arg !== 'string')
  ) {
    throw new TypeError('Verification check args must be an array of strings.');
  }
}

function isPassedCheckResult(result: CheckResult): result is PassedCheckResult {
  return (
    result.status === 'passed' &&
    result.exitCode === 0 &&
    result.signal === null &&
    result.timedOut === false &&
    result.error === undefined
  );
}

function elapsedMilliseconds(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

function formatError(error: NodeJS.ErrnoException): string {
  return error.code ? `${error.code}: ${error.message}` : error.message;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return value;
}
