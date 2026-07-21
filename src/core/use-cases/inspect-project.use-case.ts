import { Inject, Injectable } from '@nestjs/common';
import { ProjectFingerprint } from '../domain/project-fingerprint';
import { PROJECT_MEMORY_PORT } from '../ports/project-memory.port';
import type { ProjectMemoryPort } from '../ports/project-memory.port';
import type { RepositoryMemoryRecord } from '../ports/project-memory.port';
import { ProjectFingerprintBuilder } from '../services/project-fingerprint.builder';

@Injectable()
export class InspectProjectUseCase {
  constructor(
    @Inject(PROJECT_MEMORY_PORT)
    private readonly memory: ProjectMemoryPort,
    private readonly fingerprintBuilder: ProjectFingerprintBuilder,
  ) {}

  async execute(repositoryPath: string): Promise<ProjectFingerprint> {
    const inspection = await this.executeDetailed(repositoryPath);
    return inspection.fingerprint;
  }

  async executeDetailed(repositoryPath: string): Promise<ProjectInspection> {
    const snapshot = await this.memory.inspect(repositoryPath);
    const fingerprint = this.fingerprintBuilder.build(snapshot);
    return {
      repositoryPath,
      fingerprint,
      memories: snapshot.memories.map(toSafeMemory),
      metadata: snapshot.metadata,
    };
  }
}

export interface ProjectInspection {
  repositoryPath: string;
  fingerprint: ProjectFingerprint;
  memories: SafeMemory[];
  metadata?: { dataset?: string; generatedAt?: string };
}

export interface SafeMemory {
  id: string;
  type: string;
  title: string;
  path?: string;
  summary: string;
}

function toSafeMemory(memory: RepositoryMemoryRecord): SafeMemory {
  const path = typeof memory.metadata.path === 'string'
    ? memory.metadata.path
    : memory.type === 'file' && memory.id.startsWith('file:')
      ? memory.id.slice(5)
      : undefined;
  return {
    id: memory.id,
    type: memory.type,
    title: redact(memory.title),
    ...(path ? { path: redact(path) } : {}),
    summary: redact(memory.content).slice(0, 280),
  };
}

function redact(value: string): string {
  return value
    .replace(/(?:sk|pk|api|token|secret|password|key)[_-]?['"`:=\s]+[A-Za-z0-9_./+=-]{8,}/gi, '[redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
}
