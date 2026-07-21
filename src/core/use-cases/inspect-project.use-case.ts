import { Inject, Injectable } from '@nestjs/common';
import { ProjectFingerprint } from '../domain/project-fingerprint';
import { PROJECT_MEMORY_PORT } from '../ports/project-memory.port';
import type { ProjectMemoryPort } from '../ports/project-memory.port';
import { ProjectFingerprintBuilder } from '../services/project-fingerprint.builder';

@Injectable()
export class InspectProjectUseCase {
  constructor(
    @Inject(PROJECT_MEMORY_PORT)
    private readonly memory: ProjectMemoryPort,
    private readonly fingerprintBuilder: ProjectFingerprintBuilder,
  ) {}

  async execute(repositoryPath: string): Promise<ProjectFingerprint> {
    const snapshot = await this.memory.inspect(repositoryPath);
    return this.fingerprintBuilder.build(snapshot);
  }
}
