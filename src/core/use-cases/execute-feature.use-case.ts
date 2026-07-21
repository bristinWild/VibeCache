import { Inject, Injectable } from '@nestjs/common';
import { generateRunId } from '../../adapters/runs';
import type { FeaturePlan, PlannedTask } from '../domain/feature-plan';
import {
  FEATURE_RUN_SCHEMA_VERSION,
  type AgentExecutionSummary,
  type FeatureRun,
  type FeatureRunWaveResult,
  type VerificationSummary,
} from '../domain/feature-run';
import {
  AGENT_RUNNER_PORT,
  type AgentRunnerPort,
  type AgentWaveRunResult,
} from '../ports/agent-runner.port';
import {
  EXECUTION_LEASE_PORT,
  type ExecutionLeasePort,
} from '../ports/execution-lease.port';
import {
  CHECK_RUNNER_PORT,
  type CheckResult,
  type CheckRunnerPort,
  type PassedCheckResult,
} from '../ports/check-runner.port';
import {
  RECEIPT_STORE_PORT,
  FEATURE_RECEIPT_SCHEMA_VERSION,
  type FeatureReceipt,
  type ReceiptStorePort,
} from '../ports/receipt-store.port';
import {
  REPOSITORY_STATE_PORT,
  type RepositoryStatusEntry,
  type RepositoryStatePort,
} from '../ports/repository-state.port';
import {
  REPOSITORY_INTEGRITY_PORT,
  type ProtectedPathSnapshot,
  type RepositoryIntegrityPort,
} from '../ports/repository-integrity.port';
import { RUN_STORE_PORT, type RunStorePort } from '../ports/run-store.port';
import { stableDigest } from '../services/stable-digest';

export interface ExecuteFeatureInput {
  plan: FeaturePlan;
  allowDirty?: boolean;
  resumeRun?: FeatureRun;
  signal?: AbortSignal;
}

export type FeatureExecutionEvent =
  | { type: 'run-started'; runId: string; totalWaves: number }
  | {
      type: 'run-resumed';
      runId: string;
      nextWave: number;
      totalWaves: number;
    }
  | { type: 'wave-started'; runId: string; wave: number; taskIds: string[] }
  | {
      type: 'agent-finished';
      runId: string;
      wave: number;
      status: 'passed' | 'failed';
    }
  | {
      type: 'verification-finished';
      runId: string;
      wave: number | 'acceptance';
      status: 'passed' | 'failed';
    }
  | { type: 'run-finished'; runId: string; status: 'failed' | 'installed' };

export type FeatureExecutionResult =
  | {
      status: 'already-installed';
      receipt: FeatureReceipt;
    }
  | {
      status: 'failed';
      run: FeatureRun;
    }
  | {
      status: 'installed';
      run: FeatureRun;
      receipt: FeatureReceipt;
    };

export class FeatureExecutionError extends Error {
  constructor(
    readonly code:
      | 'PLAN_NOT_READY'
      | 'UNBORN_REPOSITORY'
      | 'CAPSULE_VERSION_CONFLICT'
      | 'RUN_NOT_RESUMABLE'
      | 'RUN_PLAN_MISMATCH'
      | 'REPOSITORY_DRIFT',
    message: string,
  ) {
    super(message);
    this.name = 'FeatureExecutionError';
  }
}

export type FeatureExecutionEventListener = (
  event: FeatureExecutionEvent,
) => void;

@Injectable()
export class ExecuteFeatureUseCase {
  constructor(
    @Inject(AGENT_RUNNER_PORT)
    private readonly agentRunner: AgentRunnerPort,
    @Inject(CHECK_RUNNER_PORT)
    private readonly checkRunner: CheckRunnerPort,
    @Inject(RECEIPT_STORE_PORT)
    private readonly receiptStore: ReceiptStorePort,
    @Inject(RUN_STORE_PORT)
    private readonly runStore: RunStorePort,
    @Inject(REPOSITORY_STATE_PORT)
    private readonly repositoryState: RepositoryStatePort,
    @Inject(REPOSITORY_INTEGRITY_PORT)
    private readonly repositoryIntegrity: RepositoryIntegrityPort,
    @Inject(EXECUTION_LEASE_PORT)
    private readonly executionLease: ExecutionLeasePort,
  ) {}

  async execute(
    input: ExecuteFeatureInput,
    onEvent?: FeatureExecutionEventListener,
  ): Promise<FeatureExecutionResult> {
    const { plan } = input;
    if (plan.status !== 'ready') {
      throw new FeatureExecutionError(
        'PLAN_NOT_READY',
        `Feature plan is ${plan.status}; resolve compatibility, unanswered questions, and repository bindings before execution.`,
      );
    }

    const capsuleDigest = digestPlan(plan);
    const lease = await this.executionLease.acquire(
      plan.repository.path,
      plan.feature.id,
    );

    try {
      const existingReceipt = await this.receiptStore.read(
        plan.repository.path,
        plan.feature.id,
      );
      if (existingReceipt) {
        if (
          existingReceipt.featureId === plan.feature.id &&
          existingReceipt.capsule.id === plan.feature.id &&
          existingReceipt.capsule.version === plan.feature.version &&
          existingReceipt.capsule.digest === capsuleDigest
        ) {
          if (input.resumeRun && input.resumeRun.status !== 'installed') {
            await this.runStore
              .write(
                plan.repository.path,
                reconcileInstalledRun(input.resumeRun, existingReceipt),
              )
              .catch(() => {});
          }
          return { status: 'already-installed', receipt: existingReceipt };
        }
        throw new FeatureExecutionError(
          'CAPSULE_VERSION_CONFLICT',
          `Feature "${plan.feature.id}" already has a receipt for a different capsule version or plan digest; automatic upgrades and same-version replacements are not implemented yet.`,
        );
      }

      const repository = await this.repositoryState.assertExecutionReady(
        plan.repository.path,
        { allowDirty: input.resumeRun ? true : input.allowDirty },
      );
      if (!repository.headCommit) {
        throw new FeatureExecutionError(
          'UNBORN_REPOSITORY',
          'Feature execution requires at least one Git commit so VibeCache can detect repository drift.',
        );
      }

      const choices = input.resumeRun
        ? resumableChoices(input.resumeRun)
        : resolvedChoices(plan);
      const bindings = input.resumeRun
        ? input.resumeRun.bindings
        : resolvedBindings(plan);
      const timestamp = now();
      const startWave = input.resumeRun?.nextWave ?? 1;
      let run: FeatureRun = input.resumeRun
        ? prepareResumeRun(
            input.resumeRun,
            plan,
            repository.headCommit,
            capsuleDigest,
            choices,
            bindings,
            timestamp,
          )
        : {
            schemaVersion: FEATURE_RUN_SCHEMA_VERSION,
            runId: generateRunId(new Date(timestamp)),
            featureId: plan.feature.id,
            ...(plan.request ? { request: plan.request } : {}),
            capsule: {
              id: plan.feature.id,
              version: plan.feature.version,
              digest: capsuleDigest,
            },
            repository: {
              path: plan.repository.path,
              startingCommit: repository.headCommit,
            },
            status: 'running',
            currentWave: null,
            nextWave: 1,
            choices,
            bindings,
            waveResults: [],
            timestamps: {
              createdAt: timestamp,
              startedAt: timestamp,
              updatedAt: timestamp,
            },
          };
      await this.runStore.write(plan.repository.path, run);
      emit(
        onEvent,
        input.resumeRun
          ? {
              type: 'run-resumed',
              runId: run.runId,
              nextWave: startWave,
              totalWaves: plan.waves.length,
            }
          : {
              type: 'run-started',
              runId: run.runId,
              totalWaves: plan.waves.length,
            },
      );

      const passedChecks: PassedCheckResult[] = [];

      try {
        if (input.resumeRun) {
          for (let index = 0; index < startWave - 1; index += 1) {
            const priorTasks = tasksForWave(plan.tasks, plan.waves[index]);
            const protectedBefore =
              await this.repositoryIntegrity.snapshotProtectedPaths(
                plan.repository.path,
              );
            const regression = await this.checkRunner.runAll(
              priorTasks.flatMap((task) =>
                task.verification.map((check) => ({
                  ...check,
                  cwd: plan.repository.path,
                  signal: input.signal,
                })),
              ),
            );
            await this.inspectSafeChanges(
              plan.repository.path,
              repository.headCommit,
              repository.statusEntries,
              protectedBefore,
            );
            emit(onEvent, {
              type: 'verification-finished',
              runId: run.runId,
              wave: index + 1,
              status: regression.status,
            });
            if (regression.status === 'failed') {
              run = await this.failRun(
                run,
                plan.repository.path,
                undefined,
                'regression-failed',
                `Previously completed wave ${index + 1} no longer passes verification.`,
                startWave,
                true,
              );
              emit(onEvent, {
                type: 'run-finished',
                runId: run.runId,
                status: 'failed',
              });
              return { status: 'failed', run };
            }
            passedChecks.push(...regression.checks);
          }
        }

        for (let index = startWave - 1; index < plan.waves.length; index += 1) {
          const wave = index + 1;
          const taskIds = plan.waves[index];
          const tasks = tasksForWave(plan.tasks, taskIds);
          const waveStartedAt = now();
          run = updateRunningRun(run, {
            currentWave: wave,
            nextWave: wave,
            updatedAt: waveStartedAt,
          });
          await this.runStore.write(plan.repository.path, run);
          emit(onEvent, {
            type: 'wave-started',
            runId: run.runId,
            wave,
            taskIds,
          });

          const protectedBeforeAgent =
            await this.repositoryIntegrity.snapshotProtectedPaths(
              plan.repository.path,
            );
          const agentStartedAt = now();
          const agentResult = await this.agentRunner.runWave({
            repositoryPath: plan.repository.path,
            ...(plan.request ? { request: plan.request } : {}),
            feature: { id: plan.feature.id, version: plan.feature.version },
            wave,
            tasks: tasks.map(
              ({ id, title, instructions, targets, creates }) => ({
                id,
                title,
                instructions,
                targets,
                creates,
              }),
            ),
            resolvedChoices: choices,
            semanticBindings: plan.bindings,
            signal: input.signal,
          });
          const agentCompletedAt = now();
          emit(onEvent, {
            type: 'agent-finished',
            runId: run.runId,
            wave,
            status: agentResult.status,
          });

          const agentSummary = await this.agentSummary(
            plan.repository.path,
            taskIds,
            agentResult,
            agentStartedAt,
            agentCompletedAt,
            repository.headCommit,
            repository.statusEntries,
            protectedBeforeAgent,
          );

          if (agentResult.status === 'failed') {
            const waveResult: FeatureRunWaveResult = {
              wave,
              taskIds,
              status: 'failed',
              agents: [agentSummary],
              verification: skippedVerification(
                'Verification was skipped because the agent did not complete successfully.',
              ),
              startedAt: waveStartedAt,
              completedAt: now(),
            };
            run = await this.failRun(
              run,
              plan.repository.path,
              waveResult,
              'agent-failed',
              agentResult.error ??
                agentResult.finalMessage ??
                `Codex failed while executing wave ${wave}.`,
              wave,
              true,
            );
            emit(onEvent, {
              type: 'run-finished',
              runId: run.runId,
              status: 'failed',
            });
            return { status: 'failed', run };
          }

          const protectedBeforeVerification =
            await this.repositoryIntegrity.snapshotProtectedPaths(
              plan.repository.path,
            );
          const verification = await this.checkRunner.runAll(
            tasks.flatMap((task) =>
              task.verification.map((check) => ({
                ...check,
                cwd: plan.repository.path,
                signal: input.signal,
              })),
            ),
          );
          await this.inspectSafeChanges(
            plan.repository.path,
            repository.headCommit,
            repository.statusEntries,
            protectedBeforeVerification,
          );
          emit(onEvent, {
            type: 'verification-finished',
            runId: run.runId,
            wave,
            status: verification.status,
          });
          const verificationSummary = summarizeVerification(verification);
          const waveResult: FeatureRunWaveResult = {
            wave,
            taskIds,
            status: verification.status === 'passed' ? 'completed' : 'failed',
            agents: [agentSummary],
            verification: verificationSummary,
            startedAt: waveStartedAt,
            completedAt: now(),
          };

          if (verification.status === 'failed') {
            run = await this.failRun(
              run,
              plan.repository.path,
              waveResult,
              'verification-failed',
              `Verification failed after wave ${wave}. Review the run record before retrying.`,
              wave,
              true,
            );
            emit(onEvent, {
              type: 'run-finished',
              runId: run.runId,
              status: 'failed',
            });
            return { status: 'failed', run };
          }

          passedChecks.push(...verification.checks);
          run = updateRunningRun(run, {
            currentWave: wave,
            nextWave: wave + 1,
            updatedAt: now(),
            waveResult,
          });
          await this.runStore.write(plan.repository.path, run);
        }

        const protectedBeforeAcceptance =
          await this.repositoryIntegrity.snapshotProtectedPaths(
            plan.repository.path,
          );
        const acceptance = await this.checkRunner.runAll(
          plan.acceptance.map((check) => ({
            ...check,
            cwd: plan.repository.path,
            signal: input.signal,
          })),
        );
        await this.inspectSafeChanges(
          plan.repository.path,
          repository.headCommit,
          repository.statusEntries,
          protectedBeforeAcceptance,
        );
        emit(onEvent, {
          type: 'verification-finished',
          runId: run.runId,
          wave: 'acceptance',
          status: acceptance.status,
        });

        if (acceptance.status === 'failed') {
          run = await this.failRun(
            run,
            plan.repository.path,
            undefined,
            'acceptance-failed',
            'Final capsule acceptance checks failed. Review the run record before retrying.',
            plan.waves.length + 1,
            true,
          );
          emit(onEvent, {
            type: 'run-finished',
            runId: run.runId,
            status: 'failed',
          });
          return { status: 'failed', run };
        }

        passedChecks.push(...acceptance.checks);
        const completedAt = now();
        const receipt: FeatureReceipt = {
          schemaVersion: FEATURE_RECEIPT_SCHEMA_VERSION,
          featureId: plan.feature.id,
          status: 'installed',
          capsule: {
            id: plan.feature.id,
            version: plan.feature.version,
            digest: capsuleDigest,
          },
          installedAt: completedAt,
          repositoryFingerprintHash: stableDigest(
            fingerprintWithoutPath(plan.repository.fingerprint),
          ),
          choices,
          bindings,
          verification: {
            status: 'passed',
            verifiedAt: completedAt,
            checks: passedChecks.map(({ id, durationMs }) => ({
              id,
              status: 'passed',
              durationMs,
            })),
          },
        };
        await this.receiptStore.write(plan.repository.path, receipt);

        run = {
          ...run,
          status: 'installed',
          currentWave: null,
          nextWave: null,
          timestamps: {
            ...run.timestamps,
            updatedAt: completedAt,
            completedAt,
          },
        };
        // The receipt is the durable installation commit point. A run-history
        // write failure after this point must not report the installed feature as
        // failed or trigger a future re-execution.
        await this.runStore.write(plan.repository.path, run).catch(() => {});
        emit(onEvent, {
          type: 'run-finished',
          runId: run.runId,
          status: 'installed',
        });
        return { status: 'installed', run, receipt };
      } catch (error) {
        if (run.status !== 'running') throw error;
        run = await this.failRun(
          run,
          plan.repository.path,
          undefined,
          'execution-error',
          errorMessage(error),
          run.nextWave ?? 1,
          false,
        );
        emit(onEvent, {
          type: 'run-finished',
          runId: run.runId,
          status: 'failed',
        });
        return { status: 'failed', run };
      }
    } finally {
      await lease.release();
    }
  }

  private async agentSummary(
    repositoryPath: string,
    taskIds: string[],
    result: AgentWaveRunResult,
    startedAt: string,
    completedAt: string,
    startingCommit: string,
    baselineStatus: RepositoryStatusEntry[],
    protectedBefore: ProtectedPathSnapshot,
  ): Promise<AgentExecutionSummary> {
    const changedFiles = await this.inspectSafeChanges(
      repositoryPath,
      startingCommit,
      baselineStatus,
      protectedBefore,
    );

    return {
      name: 'codex',
      ...(result.threadId ? { sessionId: result.threadId } : {}),
      status: result.status === 'passed' ? 'completed' : 'failed',
      taskIds,
      summary:
        result.finalMessage ??
        result.error ??
        (result.status === 'passed'
          ? 'Codex completed the requested wave.'
          : 'Codex did not complete the requested wave.'),
      changedFiles,
      startedAt,
      completedAt,
    };
  }

  private async inspectSafeChanges(
    repositoryPath: string,
    startingCommit: string,
    baselineStatus: RepositoryStatusEntry[],
    protectedBefore: ProtectedPathSnapshot,
  ): Promise<string[]> {
    const repository = await this.repositoryState.inspect(repositoryPath);
    if (repository.headCommit !== startingCommit) {
      throw new Error(
        'Codex changed repository HEAD. VibeCache agents must not create, amend, or switch commits.',
      );
    }
    const protectedAfter =
      await this.repositoryIntegrity.snapshotProtectedPaths(repositoryPath);
    if (protectedAfter.digest !== protectedBefore.digest) {
      throw new Error(
        'An external process modified protected .cliper or .vibe state. VibeCache stopped before advancing the run.',
      );
    }
    const baseline = new Map(
      baselineStatus.map((entry) => [entry.path, statusSignature(entry)]),
    );
    const changedFiles = repository.statusEntries
      .filter((entry) => baseline.get(entry.path) !== statusSignature(entry))
      .flatMap((entry) => [
        entry.path,
        ...(entry.originalPath ? [entry.originalPath] : []),
      ])
      .filter((path) => !isVibeCacheStatePath(path))
      .filter((path, index, paths) => paths.indexOf(path) === index)
      .sort();
    const protectedChanges = changedFiles.filter(isCliperMemoryPath);
    if (protectedChanges.length > 0) {
      throw new Error(
        `Codex modified generated Cliper memory: ${protectedChanges.join(', ')}.`,
      );
    }
    return changedFiles;
  }

  private async failRun(
    run: FeatureRun,
    repositoryPath: string,
    waveResult: FeatureRunWaveResult | undefined,
    code: string,
    message: string,
    wave: number,
    recoverable: boolean,
  ): Promise<FeatureRun> {
    const occurredAt = now();
    const waveResults = waveResult
      ? [...run.waveResults.slice(0, waveResult.wave - 1), waveResult]
      : run.waveResults;
    const failed: FeatureRun = {
      ...run,
      status: 'failed',
      currentWave: wave <= run.waveResults.length + 1 ? wave : run.currentWave,
      nextWave: wave,
      waveResults,
      timestamps: {
        ...run.timestamps,
        updatedAt: occurredAt,
        completedAt: occurredAt,
      },
      failure: {
        code,
        message,
        recoverable,
        ...(wave <= run.waveResults.length + 1 ? { wave } : {}),
        occurredAt,
      },
    };
    await this.runStore.write(repositoryPath, failed);
    return failed;
  }
}

function statusSignature(entry: RepositoryStatusEntry): string {
  return `${entry.indexStatus}${entry.workTreeStatus}:${entry.originalPath ?? ''}`;
}

function isVibeCacheStatePath(path: string): boolean {
  return path === '.vibe' || path.startsWith('.vibe/');
}

function isCliperMemoryPath(path: string): boolean {
  return path === '.cliper' || path.startsWith('.cliper/');
}

function tasksForWave(tasks: PlannedTask[], taskIds: string[]): PlannedTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return taskIds.map((taskId) => {
    const task = byId.get(taskId);
    if (!task) throw new Error(`Plan wave references missing task ${taskId}.`);
    return task;
  });
}

function prepareResumeRun(
  saved: FeatureRun,
  plan: FeaturePlan,
  headCommit: string,
  capsuleDigest: string,
  choices: Record<string, string | boolean>,
  bindings: Record<string, string>,
  timestamp: string,
): FeatureRun {
  if (
    (saved.status !== 'running' &&
      (saved.status !== 'failed' || !saved.failure?.recoverable)) ||
    saved.nextWave === null
  ) {
    throw new FeatureExecutionError(
      'RUN_NOT_RESUMABLE',
      `Run "${saved.runId}" is neither interrupted nor a recoverable failed run.`,
    );
  }
  if (
    saved.featureId !== plan.feature.id ||
    (saved.request ?? '') !== (plan.request ?? '') ||
    saved.capsule.version !== plan.feature.version ||
    saved.capsule.digest !== capsuleDigest ||
    saved.repository.path !== plan.repository.path
  ) {
    throw new FeatureExecutionError(
      'RUN_PLAN_MISMATCH',
      `Run "${saved.runId}" no longer matches the repository path or capsule plan.`,
    );
  }
  if (saved.nextWave > plan.waves.length + 1) {
    throw new FeatureExecutionError(
      'RUN_PLAN_MISMATCH',
      `Run "${saved.runId}" references wave ${saved.nextWave}, but the capsule has only ${plan.waves.length} implementation wave(s).`,
    );
  }
  if (saved.repository.startingCommit !== headCommit) {
    throw new FeatureExecutionError(
      'REPOSITORY_DRIFT',
      `Repository HEAD changed from ${saved.repository.startingCommit} to ${headCommit}; re-plan instead of resuming this run.`,
    );
  }

  const timestamps = { ...saved.timestamps };
  delete timestamps.completedAt;
  return {
    ...saved,
    status: 'running',
    currentWave: null,
    nextWave: saved.nextWave,
    choices,
    bindings,
    waveResults: saved.waveResults.slice(0, saved.nextWave - 1),
    timestamps: { ...timestamps, updatedAt: timestamp },
    failure: undefined,
  };
}

function resumableChoices(run: FeatureRun): Record<string, string | boolean> {
  const choices: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(run.choices)) {
    if (typeof value !== 'string' && typeof value !== 'boolean') {
      throw new FeatureExecutionError(
        'RUN_PLAN_MISMATCH',
        `Run "${run.runId}" contains a choice that cannot be passed to this capsule version.`,
      );
    }
    choices[key] = value;
  }
  return choices;
}

function resolvedChoices(plan: FeaturePlan): Record<string, string | boolean> {
  return Object.fromEntries(
    plan.questions.flatMap((question) =>
      question.answer === undefined ? [] : [[question.id, question.answer]],
    ),
  );
}

function resolvedBindings(plan: FeaturePlan): Record<string, string> {
  return Object.fromEntries(
    plan.bindings.flatMap((binding) =>
      binding.status === 'resolved' ? [[binding.target, binding.path]] : [],
    ),
  );
}

function updateRunningRun(
  run: FeatureRun,
  update: {
    currentWave: number;
    nextWave: number;
    updatedAt: string;
    waveResult?: FeatureRunWaveResult;
  },
): FeatureRun {
  return {
    ...run,
    currentWave: update.currentWave,
    nextWave: update.nextWave,
    waveResults: update.waveResult
      ? [
          ...run.waveResults.slice(0, update.waveResult.wave - 1),
          update.waveResult,
        ]
      : run.waveResults,
    timestamps: { ...run.timestamps, updatedAt: update.updatedAt },
  };
}

function summarizeVerification(result: {
  status: 'passed' | 'failed';
  checks: CheckResult[];
}): VerificationSummary {
  return {
    status: result.status,
    summary:
      result.status === 'passed'
        ? `${result.checks.length} verification check(s) passed.`
        : `${result.checks.filter((check) => check.status !== 'passed').length} verification check(s) failed.`,
    checks: result.checks.map((check) => ({
      id: check.id,
      status: check.status,
      durationMs: check.durationMs,
      ...(check.status === 'passed'
        ? {}
        : {
            summary:
              check.error ?? (check.stderr || check.stdout || check.status),
          }),
    })),
    verifiedAt: now(),
  };
}

function skippedVerification(summary: string): VerificationSummary {
  return { status: 'skipped', summary, checks: [], verifiedAt: now() };
}

function fingerprintWithoutPath(
  fingerprint: FeaturePlan['repository']['fingerprint'],
) {
  return {
    framework: fingerprint.framework,
    auth: fingerprint.auth,
    orm: fingerprint.orm,
    database: fingerprint.database,
    deployment: fingerprint.deployment,
    capabilities: fingerprint.capabilities,
  };
}

function reconcileInstalledRun(
  run: FeatureRun,
  receipt: FeatureReceipt,
): FeatureRun {
  return {
    ...run,
    status: 'installed',
    currentWave: null,
    nextWave: null,
    failure: undefined,
    timestamps: {
      ...run.timestamps,
      updatedAt: receipt.installedAt,
      completedAt: receipt.installedAt,
    },
  };
}

function digestPlan(plan: FeaturePlan): string {
  return stableDigest({
    feature: plan.feature,
    questions: plan.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      type: question.type,
      options: question.options,
      answer: question.answer,
    })),
    bindings: plan.bindings,
    tasks: plan.tasks,
    waves: plan.waves,
    acceptance: plan.acceptance,
  });
}

function now(): string {
  return new Date().toISOString();
}

function emit(
  listener: FeatureExecutionEventListener | undefined,
  event: FeatureExecutionEvent,
): void {
  try {
    listener?.(event);
  } catch {
    // Progress observers are best-effort and must never mutate execution state.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
