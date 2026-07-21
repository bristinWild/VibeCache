export const AGENT_RUNNER_PORT = Symbol('AGENT_RUNNER_PORT');

export type ResolvedChoiceValue = string | boolean;

export interface AgentWaveTask {
  id: string;
  title: string;
  instructions: string[];
  targets: string[];
  creates: string[];
}

export type AgentSemanticBinding =
  | {
      target: string;
      status: 'resolved';
      path: string;
      evidenceIds: string[];
    }
  | {
      target: string;
      status: 'ambiguous';
      candidates: string[];
      evidenceIds: string[];
    }
  | {
      target: string;
      status: 'unresolved';
      evidenceIds: string[];
    };

export interface AgentWaveRunRequest {
  repositoryPath: string;
  request?: string;
  feature: {
    id: string;
    version: string;
  };
  wave: number;
  tasks: AgentWaveTask[];
  resolvedChoices: Record<string, ResolvedChoiceValue>;
  semanticBindings: AgentSemanticBinding[];
  signal?: AbortSignal;
}

export interface AgentRunDiagnostics {
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutCapturedBytes: number;
  stderrCapturedBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface AgentWaveRunResult {
  status: 'passed' | 'failed';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  threadId?: string;
  finalMessage?: string;
  error?: string;
  diagnostics: AgentRunDiagnostics;
}

export interface AgentRunnerPort {
  runWave(request: AgentWaveRunRequest): Promise<AgentWaveRunResult>;
}
