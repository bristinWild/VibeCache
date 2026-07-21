export const PROJECT_MEMORY_PORT = Symbol('PROJECT_MEMORY_PORT');

export type RepositoryMemoryType =
  | 'architecture'
  | 'commit'
  | 'dependency'
  | 'file'
  | 'gap'
  | 'package'
  | 'repository';

export interface RepositoryMemoryRecord {
  id: string;
  type: RepositoryMemoryType;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  tags: string[];
  relationships: string[];
}

export interface RepositoryMemorySnapshot {
  repositoryPath: string;
  memories: RepositoryMemoryRecord[];
  metadata?: {
    dataset?: string;
    generatedAt?: string;
  };
}

export interface ProjectMemoryPort {
  inspect(repositoryPath: string): Promise<RepositoryMemorySnapshot>;
}
