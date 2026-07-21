export type CliperMemoryErrorCode =
  | 'INVALID_REPOSITORY_PATH'
  | 'REPOSITORY_NOT_FOUND'
  | 'MEMORY_NOT_INITIALIZED'
  | 'INVALID_METADATA'
  | 'MEMORY_UNAVAILABLE'
  | 'SEARCH_FAILED';

export class CliperMemoryError extends Error {
  constructor(
    readonly code: CliperMemoryErrorCode,
    message: string,
    readonly repositoryPath: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CliperMemoryError';
  }
}
