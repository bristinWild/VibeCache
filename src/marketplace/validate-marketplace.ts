#!/usr/bin/env node
import { loadMarketplaceIndex } from './marketplace-index';
import { FilesystemCapsuleRegistryAdapter } from '../adapters/registry/filesystem-capsule-registry.adapter';

async function main(): Promise<void> {
  const entries = loadMarketplaceIndex();
  const registry = new FilesystemCapsuleRegistryAdapter();
  const capsules = await registry.list();
  const byId = new Map(capsules.map((capsule) => [capsule.id, capsule]));
  const errors: string[] = [];

  for (const entry of entries) {
    const capsule = byId.get(entry.id);
    if (!capsule) {
      errors.push(`Marketplace entry "${entry.id}" has no registry capsule.`);
      continue;
    }
    if (capsule.version !== entry.version) {
      errors.push(
        `${entry.id} version mismatch: index ${entry.version}, capsule ${capsule.version}.`,
      );
    }
    if (capsule.category !== entry.category) {
      errors.push(
        `${entry.id} category mismatch: index ${entry.category}, capsule ${capsule.category}.`,
      );
    }
  }

  for (const capsule of capsules) {
    if (!entries.some((entry) => entry.id === capsule.id)) {
      errors.push(
        `Registry capsule "${capsule.id}" is missing from marketplace index.`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Marketplace validation failed:\n- ${errors.join('\n- ')}`);
  }

  process.stdout.write(
    `Marketplace validation passed: ${entries.length} approved capsule(s).\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
