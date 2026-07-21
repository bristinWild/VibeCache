import { BadRequestException, NotFoundException } from '@nestjs/common';
import { resolve } from 'node:path';
import { CliperMemoryError } from '../adapters/cliper/cliper-memory.errors';
import type { FeaturePlan } from '../core/domain/feature-plan';
import {
  PlanFeatureError,
  PlanFeatureUseCase,
} from '../core/use-cases/plan-feature.use-case';
import { CapsulesController } from './capsules.controller';

describe('CapsulesController', () => {
  const plan = { schemaVersion: 1, mode: 'dry-run' } as FeaturePlan;
  let execute: jest.Mock<
    ReturnType<PlanFeatureUseCase['execute']>,
    Parameters<PlanFeatureUseCase['execute']>
  >;
  let controller: CapsulesController;

  beforeEach(() => {
    execute = jest.fn<
      ReturnType<PlanFeatureUseCase['execute']>,
      Parameters<PlanFeatureUseCase['execute']>
    >();
    controller = new CapsulesController({
      execute,
    } as unknown as PlanFeatureUseCase);
  });

  it('resolves the path and delegates answers to the planning use case', async () => {
    execute.mockResolvedValue(plan);
    const answers = {
      plan: 'pro',
      yearly: true,
    };

    await expect(
      controller.plan('stripe-subscriptions', {
        path: './fixtures/project',
        answers,
      }),
    ).resolves.toBe(plan);
    expect(execute).toHaveBeenCalledWith({
      featureId: 'stripe-subscriptions',
      repositoryPath: resolve('./fixtures/project'),
      answers,
    });
  });

  it('defaults to cwd and omits absent answers', async () => {
    execute.mockResolvedValue(plan);

    await controller.plan('stripe-subscriptions');

    expect(execute).toHaveBeenCalledWith({
      featureId: 'stripe-subscriptions',
      repositoryPath: resolve(process.cwd()),
    });
  });

  it('maps a missing feature capsule to not found', async () => {
    execute.mockRejectedValue(
      new PlanFeatureError('FEATURE_NOT_FOUND', 'Capsule was not found.'),
    );

    const error = await captureException(
      controller.plan('missing-feature'),
      NotFoundException,
    );

    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toEqual({
      code: 'FEATURE_NOT_FOUND',
      message: 'Capsule was not found.',
    });
  });

  it.each(['UNKNOWN_ANSWER', 'INVALID_ANSWER'] as const)(
    'maps %s planning input errors to bad requests',
    async (code) => {
      execute.mockRejectedValue(new PlanFeatureError(code, 'Invalid input.'));

      const error = await captureException(
        controller.plan('stripe-subscriptions'),
        BadRequestException,
      );

      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toEqual({
        code,
        message: 'Invalid input.',
      });
    },
  );

  it('maps Cliper memory failures to bad requests', async () => {
    execute.mockRejectedValue(
      new CliperMemoryError(
        'MEMORY_UNAVAILABLE',
        'Run cliper sync.',
        '/workspace/project',
      ),
    );

    const error = await captureException(
      controller.plan('stripe-subscriptions'),
      BadRequestException,
    );

    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({
      code: 'MEMORY_UNAVAILABLE',
      message: 'Run cliper sync.',
    });
  });

  it('rejects malformed answers before invoking the use case', async () => {
    const error = await captureException(
      controller.plan('stripe-subscriptions', {
        answers: { plan: 42 },
      } as never),
      BadRequestException,
    );

    expect(error.getStatus()).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not hide unexpected use-case errors', async () => {
    const unexpected = new Error('unexpected');
    execute.mockRejectedValue(unexpected);

    await expect(controller.plan('stripe-subscriptions')).rejects.toBe(
      unexpected,
    );
  });
});

async function captureException<
  T extends BadRequestException | NotFoundException,
>(
  promise: Promise<unknown>,
  expectedType: new (...args: never[]) => T,
): Promise<T> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof expectedType) return error;
    throw error;
  }

  throw new Error(`Expected ${expectedType.name}, but the promise resolved.`);
}
