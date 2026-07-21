export type CapsuleRegistryErrorCode =
  | 'INVALID_FEATURE_ID'
  | 'UNSAFE_CAPSULE_PATH'
  | 'INVALID_CAPSULE'
  | 'REGISTRY_READ_FAILED';

export class CapsuleRegistryError extends Error {
  constructor(
    readonly code: CapsuleRegistryErrorCode,
    message: string,
    readonly featureId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CapsuleRegistryError';
  }
}
