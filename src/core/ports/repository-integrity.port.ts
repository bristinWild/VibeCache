export const REPOSITORY_INTEGRITY_PORT = Symbol('REPOSITORY_INTEGRITY_PORT');

export interface ProtectedPathSnapshot {
  algorithm: 'sha256';
  digest: string;
  entryCount: number;
}

/**
 * Captures VibeCache-owned and generated-memory paths without trusting Git's
 * ignore rules. Callers compare snapshots immediately around an external
 * process boundary.
 */
export interface RepositoryIntegrityPort {
  snapshotProtectedPaths(
    repositoryPath: string,
  ): Promise<ProtectedPathSnapshot>;
}
