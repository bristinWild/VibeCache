import { Module } from '@nestjs/common';
import { CliperMemoryAdapter } from '../adapters/cliper';
import { CodexAgentRunner } from '../adapters/agents';
import { GitRepositoryStateAdapter } from '../adapters/git';
import { FilesystemRepositoryIntegrityAdapter } from '../adapters/integrity';
import { FilesystemExecutionLeaseAdapter } from '../adapters/leases';
import { FilesystemCapsuleRegistryAdapter } from '../adapters/registry';
import { JsonRunStore } from '../adapters/runs';
import { ProcessCheckRunner } from '../adapters/verification/process-check.runner';
import { JsonReceiptStore } from '../adapters/receipts/json-receipt.store';
import { AGENT_RUNNER_PORT } from './ports/agent-runner.port';
import { CAPSULE_REGISTRY_PORT } from './ports/capsule-registry.port';
import { CHECK_RUNNER_PORT } from './ports/check-runner.port';
import { EXECUTION_LEASE_PORT } from './ports/execution-lease.port';
import { PROJECT_MEMORY_PORT } from './ports/project-memory.port';
import { RECEIPT_STORE_PORT } from './ports/receipt-store.port';
import { REPOSITORY_STATE_PORT } from './ports/repository-state.port';
import { REPOSITORY_INTEGRITY_PORT } from './ports/repository-integrity.port';
import { RUN_STORE_PORT } from './ports/run-store.port';
import { CapsuleMatcher } from './services/capsule-matcher';
import { ProjectFingerprintBuilder } from './services/project-fingerprint.builder';
import { SemanticBindingService } from './services/semantic-binding.service';
import { TaskGraphCompiler } from './services/task-graph.compiler';
import { InspectProjectUseCase } from './use-cases/inspect-project.use-case';
import { PlanFeatureUseCase } from './use-cases/plan-feature.use-case';
import { ExecuteFeatureUseCase } from './use-cases/execute-feature.use-case';

@Module({
  providers: [
    CliperMemoryAdapter,
    CodexAgentRunner,
    GitRepositoryStateAdapter,
    FilesystemRepositoryIntegrityAdapter,
    FilesystemExecutionLeaseAdapter,
    FilesystemCapsuleRegistryAdapter,
    JsonRunStore,
    ProcessCheckRunner,
    JsonReceiptStore,
    ProjectFingerprintBuilder,
    CapsuleMatcher,
    SemanticBindingService,
    TaskGraphCompiler,
    InspectProjectUseCase,
    PlanFeatureUseCase,
    ExecuteFeatureUseCase,
    {
      provide: AGENT_RUNNER_PORT,
      useExisting: CodexAgentRunner,
    },
    {
      provide: PROJECT_MEMORY_PORT,
      useExisting: CliperMemoryAdapter,
    },
    {
      provide: CAPSULE_REGISTRY_PORT,
      useExisting: FilesystemCapsuleRegistryAdapter,
    },
    {
      provide: CHECK_RUNNER_PORT,
      useExisting: ProcessCheckRunner,
    },
    {
      provide: RECEIPT_STORE_PORT,
      useExisting: JsonReceiptStore,
    },
    {
      provide: RUN_STORE_PORT,
      useExisting: JsonRunStore,
    },
    {
      provide: REPOSITORY_STATE_PORT,
      useExisting: GitRepositoryStateAdapter,
    },
    {
      provide: REPOSITORY_INTEGRITY_PORT,
      useExisting: FilesystemRepositoryIntegrityAdapter,
    },
    {
      provide: EXECUTION_LEASE_PORT,
      useExisting: FilesystemExecutionLeaseAdapter,
    },
  ],
  exports: [
    InspectProjectUseCase,
    PlanFeatureUseCase,
    ExecuteFeatureUseCase,
    AGENT_RUNNER_PORT,
    CAPSULE_REGISTRY_PORT,
    CHECK_RUNNER_PORT,
    RECEIPT_STORE_PORT,
    RUN_STORE_PORT,
    REPOSITORY_STATE_PORT,
    REPOSITORY_INTEGRITY_PORT,
    EXECUTION_LEASE_PORT,
  ],
})
export class CoreModule {}
