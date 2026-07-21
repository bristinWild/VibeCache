import { Inject, Injectable, Optional } from '@nestjs/common';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse } from 'yaml';
import { Capsule, parseCapsule } from '../../core/domain/capsule';
import { CapsuleRegistryPort } from '../../core/ports/capsule-registry.port';
import { CapsuleRegistryError } from './capsule-registry.errors';

export const CAPSULE_REGISTRY_ROOT = Symbol('CAPSULE_REGISTRY_ROOT');

const SAFE_FEATURE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CAPSULE_FILENAME = 'capsule.yaml';

@Injectable()
export class FilesystemCapsuleRegistryAdapter implements CapsuleRegistryPort {
  readonly registryRoot: string;

  constructor(
    @Optional()
    @Inject(CAPSULE_REGISTRY_ROOT)
    registryRoot?: string,
  ) {
    this.registryRoot = resolve(
      registryRoot ?? join(__dirname, '../../../registry'),
    );
  }

  async list(): Promise<Capsule[]> {
    if (!existsSync(this.registryRoot)) return [];

    let featureIds: string[];

    try {
      featureIds = readdirSync(this.registryRoot, { withFileTypes: true })
        .filter(
          (entry) => entry.isDirectory() && SAFE_FEATURE_ID.test(entry.name),
        )
        .map((entry) => entry.name)
        .sort(compareFeatureIds);
    } catch (error) {
      throw new CapsuleRegistryError(
        'REGISTRY_READ_FAILED',
        `Unable to read capsule registry at "${this.registryRoot}".`,
        undefined,
        { cause: error },
      );
    }

    const capsules = await Promise.all(
      featureIds.map((featureId) => this.find(featureId)),
    );

    return capsules.filter((capsule): capsule is Capsule => capsule !== null);
  }

  async find(featureId: string): Promise<Capsule | null> {
    assertSafeFeatureId(featureId);

    const capsulePath = resolve(this.registryRoot, featureId, CAPSULE_FILENAME);
    assertContainedPath(this.registryRoot, capsulePath, featureId);

    if (!existsSync(capsulePath)) return null;

    try {
      const registryRoot = realpathSync(this.registryRoot);
      const realCapsulePath = realpathSync(capsulePath);
      assertContainedPath(registryRoot, realCapsulePath, featureId);

      if (!statSync(realCapsulePath).isFile()) return null;

      const capsule = parseCapsule(
        parse(await readFile(realCapsulePath, 'utf8')) as unknown,
      );

      if (capsule.id !== featureId) {
        throw new Error(
          `Capsule id "${capsule.id}" must match registry directory "${featureId}".`,
        );
      }

      return capsule;
    } catch (error) {
      if (error instanceof CapsuleRegistryError) throw error;

      throw new CapsuleRegistryError(
        'INVALID_CAPSULE',
        `Capsule "${featureId}" at "${capsulePath}" is invalid: ${errorMessage(error)}`,
        featureId,
        { cause: error },
      );
    }
  }
}

function assertSafeFeatureId(featureId: string): void {
  if (!SAFE_FEATURE_ID.test(featureId)) {
    throw new CapsuleRegistryError(
      'INVALID_FEATURE_ID',
      `Unsafe capsule feature id "${featureId}". Use lowercase letters, numbers, and single hyphens only.`,
      featureId,
    );
  }
}

function assertContainedPath(
  registryRoot: string,
  candidatePath: string,
  featureId: string,
): void {
  const childPath = relative(registryRoot, candidatePath);

  if (
    childPath === '' ||
    childPath === '..' ||
    childPath.startsWith(`..${sep}`) ||
    isAbsolute(childPath)
  ) {
    throw new CapsuleRegistryError(
      'UNSAFE_CAPSULE_PATH',
      `Capsule "${featureId}" resolves outside registry root "${registryRoot}".`,
      featureId,
    );
  }
}

function compareFeatureIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
