export const EXECUTION_LEASE_PORT = Symbol('EXECUTION_LEASE_PORT');

export const EXECUTION_LEASE_SCHEMA_VERSION = 1 as const;

export interface ExecutionLeaseOwner {
  schemaVersion: typeof EXECUTION_LEASE_SCHEMA_VERSION;
  token: string;
  featureId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export interface ExecutionLease {
  repositoryPath: string;
  owner: ExecutionLeaseOwner;
  /**
   * Releases this owner only. Repeated or concurrent calls on the same handle
   * are idempotent, and a replaced lock is never removed.
   */
  release(): Promise<void>;
}

export interface ExecutionLeasePort {
  /** Acquires the single execution lease for a repository. */
  acquire(repositoryPath: string, featureId: string): Promise<ExecutionLease>;
}
