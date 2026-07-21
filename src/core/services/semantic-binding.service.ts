import { RepositoryMemoryRecord } from '../ports/project-memory.port';

export type SemanticBinding =
  | {
      target: string;
      status: 'resolved';
      path: string;
      evidenceIds: string[];
    }
  | {
      target: string;
      status: 'ambiguous';
      candidates: string[];
      evidenceIds: string[];
    }
  | {
      target: string;
      status: 'unresolved';
      evidenceIds: string[];
    };

interface Candidate {
  path: string;
  score: number;
  evidenceId: string;
}

/**
 * Resolves capsule concepts to repository-relative paths using Cliper evidence.
 * It intentionally leaves unknown or tied targets unresolved instead of inventing
 * a location that an implementation agent could treat as authoritative.
 */
export class SemanticBindingService {
  bind(
    targets: readonly string[],
    memories: RepositoryMemoryRecord[],
  ): SemanticBinding[] {
    return [...new Set(targets)].map((target) =>
      this.resolve(target, memories),
    );
  }

  private resolve(
    target: string,
    memories: RepositoryMemoryRecord[],
  ): SemanticBinding {
    const candidates = memories.flatMap((memory) =>
      this.candidateFor(target, memory),
    );

    if (candidates.length === 0) {
      return { target, status: 'unresolved', evidenceIds: [] };
    }

    const byPath = new Map<string, Candidate>();
    for (const candidate of candidates) {
      const current = byPath.get(candidate.path);
      if (!current || candidate.score > current.score) {
        byPath.set(candidate.path, candidate);
      }
    }

    const ranked = [...byPath.values()].sort(
      (left, right) =>
        right.score - left.score || left.path.localeCompare(right.path),
    );
    const bestScore = ranked[0].score;
    const best = ranked.filter((candidate) => candidate.score === bestScore);

    if (best.length > 1) {
      return {
        target,
        status: 'ambiguous',
        candidates: best.map((candidate) => candidate.path),
        evidenceIds: best.map((candidate) => candidate.evidenceId),
      };
    }

    return {
      target,
      status: 'resolved',
      path: best[0].path,
      evidenceIds: candidates
        .filter((candidate) => candidate.path === best[0].path)
        .map((candidate) => candidate.evidenceId)
        .filter((id, index, values) => values.indexOf(id) === index),
    };
  }

  private candidateFor(
    target: string,
    memory: RepositoryMemoryRecord,
  ): Candidate[] {
    const path = memoryPath(memory);
    if (!path) return [];

    const searchable = searchableText(memory);

    if (['database-schema', 'subscription-model'].includes(target)) {
      if (/^prisma\/schema\.prisma$/i.test(path)) {
        return [{ path, score: 100, evidenceId: memory.id }];
      }
      if (/schema/.test(searchable) && /prisma/.test(searchable)) {
        return [{ path, score: 70, evidenceId: memory.id }];
      }
    }

    if (target === 'database-client') {
      if (/database-client|prisma client/.test(searchable)) {
        return [{ path, score: 90, evidenceId: memory.id }];
      }
    }

    if (['auth-boundary', 'user-identity'].includes(target)) {
      const role = stringMetadata(memory, 'role');
      if (/auth/.test(role)) {
        return [{ path, score: 100, evidenceId: memory.id }];
      }
      if (/authentication/.test(searchable) && /supabase|auth/.test(path)) {
        return [{ path, score: 80, evidenceId: memory.id }];
      }
    }

    if (
      ['server-route-root', 'server-route', 'webhook-route'].includes(target)
    ) {
      const marker = '/app/api/';
      const markerIndex = path.indexOf(marker);
      if (markerIndex >= 0 && /\/route\.[cm]?[jt]sx?$/.test(path)) {
        return [
          {
            path: path.slice(0, markerIndex + marker.length - 1),
            score: 100,
            evidenceId: memory.id,
          },
        ];
      }
      if (/server-route|route-handler/.test(searchable)) {
        return [{ path, score: 60, evidenceId: memory.id }];
      }
    }

    return [];
  }
}

function memoryPath(memory: RepositoryMemoryRecord): string | null {
  const metadataPath = memory.metadata.path;
  if (typeof metadataPath === 'string' && metadataPath.length > 0) {
    return normalizePath(metadataPath);
  }

  if (memory.type === 'file' && memory.id.startsWith('file:')) {
    return normalizePath(memory.id.slice('file:'.length));
  }

  return null;
}

function searchableText(memory: RepositoryMemoryRecord): string {
  return [
    memory.title,
    memory.content,
    ...memory.tags,
    ...Object.values(memory.metadata).filter(
      (value): value is string => typeof value === 'string',
    ),
  ]
    .join(' ')
    .toLowerCase();
}

function stringMetadata(memory: RepositoryMemoryRecord, key: string): string {
  const value = memory.metadata[key];
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}
