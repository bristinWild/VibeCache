export const RECEIPT_STORE_PORT = Symbol('RECEIPT_STORE_PORT');
export const FEATURE_RECEIPT_SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface PassedVerification {
  status: 'passed';
  verifiedAt: string;
  checks: ReceiptCheckSummary[];
}

export interface ReceiptCheckSummary {
  id: string;
  status: 'passed';
  durationMs: number;
}

export interface FeatureReceipt {
  schemaVersion: typeof FEATURE_RECEIPT_SCHEMA_VERSION;
  featureId: string;
  status: 'installed';
  capsule: {
    id: string;
    version: string;
    digest: string;
  };
  installedAt: string;
  repositoryFingerprintHash?: string;
  choices?: Record<string, JsonValue>;
  bindings?: Record<string, string>;
  verification: PassedVerification;
}

export interface ReceiptStorePort {
  read(projectRoot: string, featureId: string): Promise<FeatureReceipt | null>;
  write(projectRoot: string, receipt: FeatureReceipt): Promise<void>;
}
