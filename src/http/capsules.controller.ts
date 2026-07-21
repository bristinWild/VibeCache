import {
  BadRequestException,
  Body,
  Controller,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { resolve } from 'node:path';
import { CliperMemoryError } from '../adapters/cliper/cliper-memory.errors';
import type { CapsuleAnswer } from '../core/domain/feature-plan';
import {
  PlanFeatureError,
  PlanFeatureUseCase,
} from '../core/use-cases/plan-feature.use-case';

export interface PlanFeatureRequest {
  path?: string;
  answers?: Record<string, CapsuleAnswer>;
}

@Controller('capsules')
export class CapsulesController {
  constructor(private readonly planFeature: PlanFeatureUseCase) {}

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
    repositoryPath: resolve(requestPath ?? process.cwd()),
    ...(answers ? { answers } : {}),
  };
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
