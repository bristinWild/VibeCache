import type { RepositoryStateSnapshot } from '../../core/ports/repository-state.port';

export type GitRepositoryStateErrorCode =
  | 'TARGET_NOT_FOUND'
  | 'TARGET_NOT_DIRECTORY'
  | 'GIT_UNAVAILABLE'
  | 'GIT_INSPECTION_FAILED'
  | 'NOT_GIT_REPOSITORY'
  | 'REPOSITORY_ROOT_MISMATCH'
  | 'DIRTY_WORK_TREE';

export class GitRepositoryStateError extends Error {
  constructor(
    readonly code: GitRepositoryStateErrorCode,
    message: string,
    readonly targetPath: string,
    readonly state?: RepositoryStateSnapshot,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GitRepositoryStateError';
  }
}
