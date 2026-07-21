import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { homedir } from 'node:os';
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
      const inspectDetailed = this.inspectProject as InspectProjectUseCase & {
        executeDetailed?: (path: string) => Promise<unknown>;
      };
      return inspectDetailed.executeDetailed
        ? await inspectDetailed.executeDetailed(repositoryPath)
        : await this.inspectProject.execute(repositoryPath);
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

  return resolve(expandHome(requestPath ?? process.cwd()));
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? `${homedir()}/${path.slice(2)}` : path;
}
