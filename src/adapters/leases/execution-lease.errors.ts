import type { ExecutionLeaseOwner } from '../../core/ports/execution-lease.port';

export type ExecutionLeaseBusyReason = 'live-local-owner' | 'foreign-owner';

export class ExecutionLeaseBusyError extends Error {
  readonly code = 'EXECUTION_LEASE_BUSY' as const;

  constructor(
    readonly repositoryPath: string,
    readonly owner: ExecutionLeaseOwner,
    readonly reason: ExecutionLeaseBusyReason,
  ) {
    const ownerDescription = `${owner.featureId} (PID ${owner.pid} on ${owner.hostname})`;
    const detail =
      reason === 'foreign-owner'
        ? 'Its PID cannot be checked safely from this host.'
        : 'That process is still running.';
    super(
      `Repository execution is already owned by ${ownerDescription}. ${detail}`,
    );
    this.name = 'ExecutionLeaseBusyError';
  }
}

export type ExecutionLeaseStateErrorCode =
  | 'INVALID_REPOSITORY'
  | 'INVALID_FEATURE_ID'
  | 'UNSAFE_LEASE_PATH'
  | 'INVALID_LEASE_RECORD'
  | 'PROCESS_INSPECTION_FAILED'
  | 'STALE_RECLAIM_CONTENDED';

export class ExecutionLeaseStateError extends Error {
  constructor(
    readonly code: ExecutionLeaseStateErrorCode,
    message: string,
    readonly repositoryPath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExecutionLeaseStateError';
  }
}

export class ExecutionLeaseOwnershipError extends Error {
  readonly code = 'EXECUTION_LEASE_OWNERSHIP_LOST' as const;

  constructor(
    readonly repositoryPath: string,
    readonly expectedToken: string,
    readonly actualOwner: ExecutionLeaseOwner,
  ) {
    super(
      `Execution lease ownership changed to ${actualOwner.featureId} (PID ${actualOwner.pid}); refusing to release another owner's lock.`,
    );
    this.name = 'ExecutionLeaseOwnershipError';
  }
}
