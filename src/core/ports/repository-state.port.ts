export const REPOSITORY_STATE_PORT = Symbol('REPOSITORY_STATE_PORT');

export interface RepositoryStatusEntry {
  indexStatus: string;
  workTreeStatus: string;
  path: string;
  originalPath?: string;
}

export interface RepositoryStateSnapshot {
  targetPath: string;
  isInsideWorkTree: boolean;
  repositoryRoot: string | null;
  headCommit: string | null;
  statusEntries: RepositoryStatusEntry[];
  isClean: boolean;
}

export interface ExecutionReadinessOptions {
  allowDirty?: boolean;
}

export interface RepositoryStatePort {
  inspect(targetPath: string): Promise<RepositoryStateSnapshot>;

  assertExecutionReady(
    targetPath: string,
    options?: ExecutionReadinessOptions,
  ): Promise<RepositoryStateSnapshot>;
}
