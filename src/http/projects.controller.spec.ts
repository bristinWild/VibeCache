import { BadRequestException } from '@nestjs/common';
import { resolve } from 'node:path';
import { CliperMemoryError } from '../adapters/cliper/cliper-memory.errors';
import type { ProjectFingerprint } from '../core/domain/project-fingerprint';
import { InspectProjectUseCase } from '../core/use-cases/inspect-project.use-case';
import { ProjectsController } from './projects.controller';

describe('ProjectsController', () => {
  const fingerprint = {
    repositoryPath: '/workspace/project',
  } as ProjectFingerprint;
  let execute: jest.Mock<
    ReturnType<InspectProjectUseCase['execute']>,
    Parameters<InspectProjectUseCase['execute']>
  >;
  let controller: ProjectsController;

  beforeEach(() => {
    execute = jest.fn<
      ReturnType<InspectProjectUseCase['execute']>,
      Parameters<InspectProjectUseCase['execute']>
    >();
    controller = new ProjectsController({
      execute,
    } as unknown as InspectProjectUseCase);
  });

  it('resolves the repository path and delegates inspection', async () => {
    execute.mockResolvedValue(fingerprint);

    await expect(
      controller.inspect({ path: './fixtures/project' }),
    ).resolves.toBe(fingerprint);
    expect(execute).toHaveBeenCalledWith(resolve('./fixtures/project'));
  });

  it('defaults to the current working directory', async () => {
    execute.mockResolvedValue(fingerprint);

    await controller.inspect();

    expect(execute).toHaveBeenCalledWith(resolve(process.cwd()));
  });

  it('maps Cliper memory errors to bad requests', async () => {
    const cliperError = new CliperMemoryError(
      'MEMORY_NOT_INITIALIZED',
      'Run cliper init.',
      '/workspace/project',
    );
    execute.mockRejectedValue(cliperError);

    const error = await captureBadRequest(
      controller.inspect({ path: '/workspace/project' }),
    );

    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({
      code: 'MEMORY_NOT_INITIALIZED',
      message: 'Run cliper init.',
    });
  });

  it('rejects a non-string path before invoking the use case', async () => {
    const error = await captureBadRequest(
      controller.inspect({ path: 42 } as unknown as { path: string }),
    );

    expect(error.getStatus()).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not hide unexpected use-case errors', async () => {
    const unexpected = new Error('unexpected');
    execute.mockRejectedValue(unexpected);

    await expect(controller.inspect()).rejects.toBe(unexpected);
  });
});

async function captureBadRequest(
  promise: Promise<unknown>,
): Promise<BadRequestException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BadRequestException) return error;
    throw error;
  }

  throw new Error('Expected BadRequestException, but the promise resolved.');
}
