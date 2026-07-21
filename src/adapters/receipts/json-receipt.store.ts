import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import {
  FEATURE_RECEIPT_SCHEMA_VERSION,
  type FeatureReceipt,
  type ReceiptStorePort,
} from '../../core/ports/receipt-store.port';

const SAFE_FEATURE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MAX_FEATURE_ID_LENGTH = 128;

export class JsonReceiptStore implements ReceiptStorePort {
  async read(
    projectRoot: string,
    featureId: string,
  ): Promise<FeatureReceipt | null> {
    assertSafeFeatureId(featureId);
    const paths = await this.paths(projectRoot, featureId);

    if (!(await isSafeDirectory(paths.vibeDirectory, false))) {
      return null;
    }
    if (!(await isSafeDirectory(paths.featuresDirectory, false))) {
      return null;
    }

    const receiptStat = await lstatIfExists(paths.receiptPath);
    if (!receiptStat) {
      return null;
    }
    if (receiptStat.isSymbolicLink() || !receiptStat.isFile()) {
      throw new Error(
        `Receipt path is not a regular file: ${paths.receiptPath}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(paths.receiptPath, 'utf8'));
    } catch (error) {
      throw new Error(
        `Invalid feature receipt for "${featureId}": ${errorMessage(error)}`,
      );
    }

    assertFeatureReceipt(parsed, featureId);
    return parsed;
  }

  async write(projectRoot: string, receipt: FeatureReceipt): Promise<void> {
    assertFeatureReceipt(receipt, receipt.featureId);
    const paths = await this.paths(projectRoot, receipt.featureId);

    await ensureSafeDirectory(paths.vibeDirectory);
    await ensureSafeDirectory(paths.featuresDirectory);

    const existingStat = await lstatIfExists(paths.receiptPath);
    if (existingStat?.isSymbolicLink()) {
      throw new Error(
        `Refusing to replace symbolic link: ${paths.receiptPath}`,
      );
    }
    if (existingStat && !existingStat.isFile()) {
      throw new Error(
        `Receipt path is not a regular file: ${paths.receiptPath}`,
      );
    }

    const serialized = stableSerialize(receipt);
    if (existingStat) {
      const existing = await readFile(paths.receiptPath, 'utf8');
      if (existing === serialized) {
        return;
      }
    }

    const temporaryPath = join(
      paths.featuresDirectory,
      `.${receipt.featureId}.${process.pid}.${randomUUID()}.tmp`,
    );

    try {
      await writeFile(temporaryPath, serialized, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporaryPath, paths.receiptPath);
    } finally {
      await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
  }

  private async paths(projectRoot: string, featureId: string) {
    if (!projectRoot.trim()) {
      throw new TypeError('Project root must not be empty.');
    }

    const root = await realpath(resolve(projectRoot));
    const vibeDirectory = join(root, '.vibe');
    const featuresDirectory = join(vibeDirectory, 'features');
    const receiptPath = join(featuresDirectory, `${featureId}.json`);
    const relativeReceiptPath = relative(featuresDirectory, receiptPath);

    if (
      relativeReceiptPath.startsWith('..') ||
      relativeReceiptPath.includes('/') ||
      relativeReceiptPath.includes('\\')
    ) {
      throw new Error(`Unsafe receipt path for feature id "${featureId}".`);
    }

    return { vibeDirectory, featuresDirectory, receiptPath };
  }
}

export function assertSafeFeatureId(featureId: string): void {
  if (
    typeof featureId !== 'string' ||
    featureId.length === 0 ||
    featureId.length > MAX_FEATURE_ID_LENGTH ||
    !SAFE_FEATURE_ID.test(featureId)
  ) {
    throw new TypeError(
      'Feature id must contain only lowercase letters and numbers separated by ., _, or -.',
    );
  }
}

function assertFeatureReceipt(
  value: unknown,
  expectedFeatureId: string,
): asserts value is FeatureReceipt {
  if (!isRecord(value)) {
    throw new TypeError('Feature receipt must be an object.');
  }

  assertSafeFeatureId(expectedFeatureId);
  assertSafeFeatureId(stringProperty(value, 'featureId'));

  if (value.featureId !== expectedFeatureId) {
    throw new TypeError('Feature receipt id does not match its receipt path.');
  }
  if (value.schemaVersion !== FEATURE_RECEIPT_SCHEMA_VERSION) {
    throw new TypeError(
      `Unsupported feature receipt schema version: ${String(value.schemaVersion)}.`,
    );
  }
  if (value.status !== 'installed') {
    throw new TypeError('Feature receipt status must be "installed".');
  }

  assertIsoDate(stringProperty(value, 'installedAt'), 'installedAt');

  if (!isRecord(value.capsule)) {
    throw new TypeError('Feature receipt capsule must be an object.');
  }
  nonEmptyString(value.capsule.id, 'capsule.id');
  if (value.capsule.id !== value.featureId) {
    throw new TypeError('Feature receipt capsule id must match feature id.');
  }
  nonEmptyString(value.capsule.version, 'capsule.version');
  nonEmptyString(value.capsule.digest, 'capsule.digest');

  if (!isRecord(value.verification)) {
    throw new TypeError('Feature receipt verification must be an object.');
  }
  if (value.verification.status !== 'passed') {
    throw new TypeError(
      'An installed feature receipt requires passed verification.',
    );
  }
  assertIsoDate(
    stringProperty(value.verification, 'verifiedAt'),
    'verification.verifiedAt',
  );
  if (!Array.isArray(value.verification.checks)) {
    throw new TypeError(
      'Feature receipt verification checks must be an array.',
    );
  }
  for (const check of value.verification.checks) {
    assertPassedCheck(check);
  }
}

function assertPassedCheck(value: unknown): void {
  if (!isRecord(value) || value.status !== 'passed') {
    throw new TypeError('Installed receipt cannot contain a failed check.');
  }
  nonEmptyString(value.id, 'verification.check.id');
  if (
    typeof value.durationMs !== 'number' ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0
  )
    throw new TypeError('Passed check duration must be non-negative.');
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  const existing = await lstatIfExists(directory);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Expected a non-symlink directory: ${directory}`);
    }
    return;
  }

  await mkdir(directory);

  if (!(await isSafeDirectory(directory, true))) {
    throw new Error(`Could not create safe receipt directory: ${directory}`);
  }
}

async function isSafeDirectory(
  directory: string,
  mustExist: boolean,
): Promise<boolean> {
  const stat = await lstatIfExists(directory);
  if (!stat) {
    if (mustExist) {
      throw new Error(`Directory does not exist: ${directory}`);
    }
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Expected a non-symlink directory: ${directory}`);
  }
  return true;
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function stableSerialize(value: FeatureReceipt): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringProperty(
  record: Record<string, unknown>,
  property: string,
): string {
  const value = record[property];
  nonEmptyString(value, property);
  return value;
}

function nonEmptyString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

function assertIsoDate(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO date string.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
