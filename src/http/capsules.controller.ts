import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Optional,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { CliperMemoryError } from '../adapters/cliper/cliper-memory.errors';
import type { CapsuleAnswer } from '../core/domain/feature-plan';
import {
  PlanFeatureError,
  PlanFeatureUseCase,
} from '../core/use-cases/plan-feature.use-case';
import { CAPSULE_REGISTRY_PORT } from '../core/ports/capsule-registry.port';
import type { CapsuleRegistryPort } from '../core/ports/capsule-registry.port';
import {
  FeatureExecutionError,
  ExecuteFeatureUseCase,
} from '../core/use-cases/execute-feature.use-case';

export interface PlanFeatureRequest {
  path?: string;
  request?: string;
  answers?: Record<string, CapsuleAnswer>;
  allowDirty?: boolean;
}

@Controller('capsules')
export class CapsulesController {
  constructor(
    private readonly planFeature: PlanFeatureUseCase,
    @Optional()
    @Inject(CAPSULE_REGISTRY_PORT)
    private readonly registry?: CapsuleRegistryPort,
    @Optional()
    private readonly executeFeature?: ExecuteFeatureUseCase,
  ) {}

  @Get()
  list() {
    if (!this.registry) return [];
    return this.registry.list();
  }

  @Get(':featureId')
  async find(@Param('featureId') featureId: string) {
    if (!this.registry) throw new NotFoundException();
    const capsule = await this.registry.find(featureId);
    if (!capsule) {
      throw new NotFoundException({
        code: 'FEATURE_NOT_FOUND',
        message: `Capsule "${featureId}" was not found.`,
      });
    }
    return capsule;
  }

  @Post(':featureId/execute')
  async execute(
    @Param('featureId') featureId: string,
    @Body() body: PlanFeatureRequest = {},
  ) {
    if (!this.executeFeature) {
      throw new BadRequestException({ code: 'EXECUTION_UNAVAILABLE', message: 'Execution is not available.' });
    }

    const input = planRequest(featureId, body);
    try {
      const plan = await this.planFeature.execute(input);
      return await this.executeFeature.execute({ plan, allowDirty: body.allowDirty });
    } catch (error) {
      if (error instanceof PlanFeatureError || error instanceof FeatureExecutionError) {
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      if (error instanceof CliperMemoryError) {
        throw new BadRequestException({ code: error.code, message: error.message });
      }
      throw error;
    }
  }

  @Post(':featureId/plan')
  async plan(
    @Param('featureId') featureId: string,
    @Body() body: PlanFeatureRequest = {},
  ) {
    const input = planRequest(featureId, body);

    try {
      return await this.planFeature.execute(input);
    } catch (error) {
      if (error instanceof PlanFeatureError) {
        const response = { code: error.code, message: error.message };
        if (error.code === 'FEATURE_NOT_FOUND') {
          throw new NotFoundException(response);
        }
        throw new BadRequestException(response);
      }

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

function planRequest(
  featureId: string,
  body: PlanFeatureRequest | null,
): {
  featureId: string;
  repositoryPath: string;
  answers?: Record<string, CapsuleAnswer>;
} {
  const requestPath = body?.path;
  if (requestPath !== undefined && typeof requestPath !== 'string') {
    throw invalidRequest('path must be a string.');
  }

  const answers = body?.answers;
  if (answers !== undefined && !isAnswers(answers)) {
    throw invalidRequest(
      'answers must be an object whose values are strings or booleans.',
    );
  }

  return {
    featureId,
    repositoryPath: resolve(expandHome(requestPath ?? process.cwd())),
    ...(body?.request?.trim() ? { request: body.request.trim() } : {}),
    ...(answers ? { answers } : {}),
  };
}

function expandHome(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? `${homedir()}/${path.slice(2)}` : path;
}

function isAnswers(value: unknown): value is Record<string, CapsuleAnswer> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (answer) => typeof answer === 'string' || typeof answer === 'boolean',
    )
  );
}

function invalidRequest(message: string): BadRequestException {
  return new BadRequestException({ code: 'INVALID_REQUEST', message });
}
