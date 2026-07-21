import { Capsule } from '../domain/capsule';

export const CAPSULE_REGISTRY_PORT = Symbol('CAPSULE_REGISTRY_PORT');

export interface CapsuleRegistryPort {
  list(): Promise<Capsule[]>;
  find(featureId: string): Promise<Capsule | null>;
}
