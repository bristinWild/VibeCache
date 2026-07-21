import { Inject, Injectable, Optional } from '@nestjs/common';
import { Cliper } from 'cliper-memory';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  ProjectMemoryPort,
  RepositoryMemoryRecord,
  RepositoryMemorySnapshot,
  RepositoryMemoryType,
} from '../../core/ports/project-memory.port';
import { CliperMemoryError } from './cliper-memory.errors';

type FocusedProfile = 'architecture' | 'dependency' | 'repository';

interface FocusedSearch {
  profile: FocusedProfile;
  query: string;
}

interface CliperMetadata {
  projectName: string;
  dataset?: string;
  generatedAt?: string;
}

interface CliperSearchRequest {
  path: string;
  query: string;
  profile: FocusedProfile;
}

export interface CliperStructuredSearchClient {
  searchStructured(options: CliperSearchRequest): Promise<unknown>;
}

export const CLIPER_SEARCH_CLIENT = Symbol('CLIPER_SEARCH_CLIENT');

const FOCUSED_SEARCHES: readonly FocusedSearch[] = [
  {
    profile: 'architecture',
    query:
      'application architecture modules authentication routes database services entry points',
  },
  {
    profile: 'dependency',
    query:
      'framework dependencies packages imports authentication database runtime',
  },
  {
    profile: 'repository',
    query:
      'repository structure language entry point modules framework deployment',
  },
];

const RESULT_SECTIONS = [
  ['architecture', 'architecture'],
  ['files', 'file'],
  ['dependencies', 'dependency'],
  ['packages', 'package'],
  ['repository', 'repository'],
  ['commits', 'commit'],
  ['gaps', 'gap'],
] as const satisfies readonly (readonly [string, RepositoryMemoryType])[];

const MEMORY_TYPES = new Set<RepositoryMemoryType>(
  RESULT_SECTIONS.map(([, type]) => type),
);

@Injectable()
export class CliperMemoryAdapter implements ProjectMemoryPort {
  private readonly client: CliperStructuredSearchClient;

  constructor(
    @Optional()
    @Inject(CLIPER_SEARCH_CLIENT)
    client?: CliperStructuredSearchClient,
  ) {
    this.client = client ?? new Cliper();
  }

  async inspect(repositoryPath: string): Promise<RepositoryMemorySnapshot> {
    const metadata = this.validateRepository(repositoryPath);

    let results: unknown[];

    try {
      results = await Promise.all(
        FOCUSED_SEARCHES.map(({ profile, query }) =>
          this.client.searchStructured({
            path: repositoryPath,
            query,
            profile,
          }),
        ),
      );
    } catch (error) {
      throw new CliperMemoryError(
        'SEARCH_FAILED',
        `Unable to read Cliper memory for "${repositoryPath}". Run \`cliper sync\` in that repository and try again.`,
        repositoryPath,
        { cause: error },
      );
    }

    const memories = this.normalizeAndDedupe(results);

    if (memories.length === 0) {
      throw new CliperMemoryError(
        'MEMORY_UNAVAILABLE',
        `No searchable local Cliper memory was found for "${metadata.projectName}". Run \`cliper auth local-json\` once, then run \`cliper sync\` in "${repositoryPath}".`,
        repositoryPath,
      );
    }

    return {
      repositoryPath,
      memories,
      metadata: {
        ...(metadata.dataset ? { dataset: metadata.dataset } : {}),
        ...(metadata.generatedAt ? { generatedAt: metadata.generatedAt } : {}),
      },
    };
  }

  private validateRepository(repositoryPath: string): CliperMetadata {
    if (!isAbsolute(repositoryPath)) {
      throw new CliperMemoryError(
        'INVALID_REPOSITORY_PATH',
        `Cliper requires an absolute repository path. Received "${repositoryPath}". Resolve it with path.resolve(...) before calling inspect().`,
        repositoryPath,
      );
    }

    if (
      !existsSync(repositoryPath) ||
      !statSync(repositoryPath).isDirectory()
    ) {
      throw new CliperMemoryError(
        'REPOSITORY_NOT_FOUND',
        `Repository directory does not exist: "${repositoryPath}".`,
        repositoryPath,
      );
    }

    const metadataPath = join(repositoryPath, '.cliper', 'metadata.json');

    if (!existsSync(metadataPath)) {
      throw new CliperMemoryError(
        'MEMORY_NOT_INITIALIZED',
        `Cliper memory is not initialized for "${repositoryPath}". Run \`cliper auth local-json\` once, then run \`cliper init --path "${repositoryPath}"\`.`,
        repositoryPath,
      );
    }

    try {
      const parsed: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'));

      if (!isRecord(parsed) || !isNonEmptyString(parsed.projectName)) {
        throw new Error('metadata.projectName must be a non-empty string');
      }

      return {
        projectName: parsed.projectName,
        ...(isNonEmptyString(parsed.dataset)
          ? { dataset: parsed.dataset }
          : {}),
        ...(isNonEmptyString(parsed.generatedAt)
          ? { generatedAt: parsed.generatedAt }
          : {}),
      };
    } catch (error) {
      throw new CliperMemoryError(
        'INVALID_METADATA',
        `Cliper metadata at "${metadataPath}" is invalid. Run \`cliper init --path "${repositoryPath}"\` to regenerate it.`,
        repositoryPath,
        { cause: error },
      );
    }
  }

  private normalizeAndDedupe(
    results: readonly unknown[],
  ): RepositoryMemoryRecord[] {
    const memories = new Map<string, RepositoryMemoryRecord>();

    for (const result of results) {
      if (!isRecord(result)) continue;

      for (const [section, fallbackType] of RESULT_SECTIONS) {
        const candidates = result[section];
        if (!Array.isArray(candidates)) continue;

        for (const candidate of candidates) {
          const normalized = normalizeMemory(candidate, fallbackType);
          if (!normalized) continue;

          const key = `${normalized.type}:${normalized.id}`;
          const existing = memories.get(key);

          if (!existing) {
            memories.set(key, normalized);
            continue;
          }

          memories.set(key, mergeMemory(existing, normalized));
        }
      }
    }

    return [...memories.values()];
  }
}

function normalizeMemory(
  value: unknown,
  fallbackType: RepositoryMemoryType,
): RepositoryMemoryRecord | null {
  if (!isRecord(value) || !isNonEmptyString(value.id)) return null;

  const type = isRepositoryMemoryType(value.type) ? value.type : fallbackType;
  const title = isNonEmptyString(value.title) ? value.title : value.id;
  const content = typeof value.content === 'string' ? value.content : '';
  const metadata = isRecord(value.metadata) ? { ...value.metadata } : {};

  return {
    id: value.id,
    type,
    title,
    content,
    metadata,
    tags: stringArray(value.tags),
    relationships: stringArray(value.relationships),
  };
}

function mergeMemory(
  current: RepositoryMemoryRecord,
  incoming: RepositoryMemoryRecord,
): RepositoryMemoryRecord {
  return {
    ...current,
    title: current.title || incoming.title,
    content: current.content || incoming.content,
    metadata: { ...incoming.metadata, ...current.metadata },
    tags: uniqueStrings([...current.tags, ...incoming.tags]),
    relationships: uniqueStrings([
      ...current.relationships,
      ...incoming.relationships,
    ]),
  };
}

function isRepositoryMemoryType(value: unknown): value is RepositoryMemoryType {
  return (
    typeof value === 'string' && MEMORY_TYPES.has(value as RepositoryMemoryType)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value.filter((item): item is string => typeof item === 'string'),
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
