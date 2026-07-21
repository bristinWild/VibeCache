import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { resolve } from 'node:path';
import { CliperMemoryError } from '../adapters/cliper/cliper-memory.errors';
import { InspectProjectUseCase } from '../core/use-cases/inspect-project.use-case';

export interface InspectProjectRequest {
  path?: string;
}

@Controller('projects')
export class ProjectsController {
  constructor(private readonly inspectProject: InspectProjectUseCase) {}

  @Post('inspect')
  async inspect(@Body() body: InspectProjectRequest = {}) {
    const repositoryPath = resolveRequestPath(body);

    try {
      return await this.inspectProject.execute(repositoryPath);
    } catch (error) {
      if (error instanceof CliperMemoryError) {
        throw new BadRequestException({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  }
}

function resolveRequestPath(body: InspectProjectRequest | null): string {
  const requestPath = body?.path;
  if (requestPath !== undefined && typeof requestPath !== 'string') {
    throw new BadRequestException({
      code: 'INVALID_REQUEST',
      message: 'path must be a string.',
    });
  }

  return resolve(requestPath ?? process.cwd());
}
