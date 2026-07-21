import type { FeatureRun } from '../domain/feature-run';

export const RUN_STORE_PORT = Symbol('RUN_STORE_PORT');

export interface RunStorePort {
  /** Returns all runs ordered newest-first by their sortable run id. */
  list(projectRoot: string): Promise<FeatureRun[]>;
  read(projectRoot: string, runId: string): Promise<FeatureRun | null>;
  write(projectRoot: string, run: FeatureRun): Promise<void>;
}
