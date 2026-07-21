export const CHECK_RUNNER_PORT = Symbol('CHECK_RUNNER_PORT');

export interface VerificationCheck {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type CheckStatus = 'passed' | 'failed' | 'timed_out' | 'error';

export interface CheckResult {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  status: CheckStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutCapturedBytes: number;
  stderrCapturedBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  error?: string;
}

export type PassedCheckResult = CheckResult & {
  status: 'passed';
  exitCode: 0;
  signal: null;
  timedOut: false;
  error?: undefined;
};

export type VerificationRunResult =
  | {
      status: 'passed';
      checks: PassedCheckResult[];
    }
  | {
      status: 'failed';
      checks: CheckResult[];
    };

export interface CheckRunnerPort {
  run(check: VerificationCheck): Promise<CheckResult>;
  runAll(checks: VerificationCheck[]): Promise<VerificationRunResult>;
}
