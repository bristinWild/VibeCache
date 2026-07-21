export {
  CapsuleSchema,
  CapsuleTaskSchema,
  VerificationCheckSchema,
  parseCapsule,
} from './core/domain/capsule';
export type {
  Capsule,
  CapsuleQuestion,
  CapsuleRequirement,
  CapsuleTask,
  VerificationCheck as CapsuleVerificationCheck,
} from './core/domain/capsule';
export type {
  CapsuleAnswer,
  FeaturePlan,
  PlannedQuestion,
  PlannedTask,
} from './core/domain/feature-plan';
export {
  FEATURE_RUN_SCHEMA_VERSION,
  FeatureRunSchema,
  parseFeatureRun,
} from './core/domain/feature-run';
export type {
  AgentExecutionSummary,
  FeatureRun,
  FeatureRunFailure,
  FeatureRunWaveResult,
  VerificationCheckSummary,
  VerificationSummary,
} from './core/domain/feature-run';
export type {
  ProjectFingerprint,
  TechnologyDetection,
  TechnologyDimension,
} from './core/domain/project-fingerprint';

export {
  CodexAgentRunner,
  buildCodexWavePrompt,
  type CodexAgentRunnerOptions,
} from './adapters/agents';
export {
  CLIPER_SEARCH_CLIENT,
  CliperMemoryAdapter,
  CliperMemoryError,
} from './adapters/cliper';
export {
  GitRepositoryStateAdapter,
  GitRepositoryStateError,
} from './adapters/git';
export { FilesystemRepositoryIntegrityAdapter } from './adapters/integrity';
export {
  ExecutionLeaseBusyError,
  ExecutionLeaseOwnershipError,
  ExecutionLeaseStateError,
  FilesystemExecutionLeaseAdapter,
  type ExecutionLeaseBusyReason,
  type ExecutionLeaseStateErrorCode,
  type FilesystemExecutionLeaseOptions,
} from './adapters/leases';
export {
  CAPSULE_REGISTRY_ROOT,
  CapsuleRegistryError,
  FilesystemCapsuleRegistryAdapter,
} from './adapters/registry';
export { JsonRunStore, assertSafeRunId, generateRunId } from './adapters/runs';
export {
  AGENT_RUNNER_PORT,
  type AgentRunDiagnostics,
  type AgentRunnerPort,
  type AgentSemanticBinding,
  type AgentWaveRunRequest,
  type AgentWaveRunResult,
  type AgentWaveTask,
  type ResolvedChoiceValue,
} from './core/ports/agent-runner.port';
export {
  ProcessCheckRunner,
  type ProcessCheckRunnerOptions,
  verificationEnvironment,
} from './adapters/verification/process-check.runner';
export {
  JsonReceiptStore,
  assertSafeFeatureId,
} from './adapters/receipts/json-receipt.store';

export {
  CAPSULE_REGISTRY_PORT,
  type CapsuleRegistryPort,
} from './core/ports/capsule-registry.port';
export {
  CHECK_RUNNER_PORT,
  type CheckResult,
  type CheckRunnerPort,
  type CheckStatus,
  type PassedCheckResult,
  type VerificationCheck as RuntimeVerificationCheck,
  type VerificationRunResult,
} from './core/ports/check-runner.port';
export {
  EXECUTION_LEASE_PORT,
  EXECUTION_LEASE_SCHEMA_VERSION,
  type ExecutionLease,
  type ExecutionLeaseOwner,
  type ExecutionLeasePort,
} from './core/ports/execution-lease.port';
export {
  PROJECT_MEMORY_PORT,
  type ProjectMemoryPort,
  type RepositoryMemoryRecord,
  type RepositoryMemorySnapshot,
  type RepositoryMemoryType,
} from './core/ports/project-memory.port';
export {
  FEATURE_RECEIPT_SCHEMA_VERSION,
  RECEIPT_STORE_PORT,
  type FeatureReceipt,
  type PassedVerification,
  type ReceiptCheckSummary,
  type ReceiptStorePort,
} from './core/ports/receipt-store.port';
export {
  REPOSITORY_STATE_PORT,
  type ExecutionReadinessOptions,
  type RepositoryStatePort,
  type RepositoryStateSnapshot,
  type RepositoryStatusEntry,
} from './core/ports/repository-state.port';
export {
  REPOSITORY_INTEGRITY_PORT,
  type ProtectedPathSnapshot,
  type RepositoryIntegrityPort,
} from './core/ports/repository-integrity.port';
export { RUN_STORE_PORT, type RunStorePort } from './core/ports/run-store.port';

export {
  CapsuleMatcher,
  type CompatibilityResult,
} from './core/services/capsule-matcher';
export { ProjectFingerprintBuilder } from './core/services/project-fingerprint.builder';
export {
  SemanticBindingService,
  type SemanticBinding,
} from './core/services/semantic-binding.service';
export {
  TaskGraphCompiler,
  TaskGraphError,
  type CompiledTaskGraph,
  type TaskGraphErrorCode,
} from './core/services/task-graph.compiler';
export { InspectProjectUseCase } from './core/use-cases/inspect-project.use-case';
export {
  ExecuteFeatureUseCase,
  FeatureExecutionError,
  type ExecuteFeatureInput,
  type FeatureExecutionEvent,
  type FeatureExecutionEventListener,
  type FeatureExecutionResult,
} from './core/use-cases/execute-feature.use-case';
export {
  PlanFeatureError,
  PlanFeatureUseCase,
  type PlanFeatureInput,
} from './core/use-cases/plan-feature.use-case';
export { CoreModule } from './core/core.module';
