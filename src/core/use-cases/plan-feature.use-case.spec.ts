import { parseCapsule } from '../domain/capsule';
import type { CapsuleRegistryPort } from '../ports/capsule-registry.port';
import type {
  ProjectMemoryPort,
  RepositoryMemorySnapshot,
} from '../ports/project-memory.port';
import { CapsuleMatcher } from '../services/capsule-matcher';
import { ProjectFingerprintBuilder } from '../services/project-fingerprint.builder';
import { SemanticBindingService } from '../services/semantic-binding.service';
import { TaskGraphCompiler } from '../services/task-graph.compiler';
import { PlanFeatureError, PlanFeatureUseCase } from './plan-feature.use-case';

const capsule = parseCapsule({
  schemaVersion: 1,
  id: 'stripe-subscriptions',
  version: '0.1.0',
  name: 'Stripe subscriptions',
  summary: 'Adds subscriptions.',
  provides: ['subscription-billing'],
  compatibility: [
    { dimension: 'framework', oneOf: ['nextjs-app-router'] },
    { dimension: 'auth', oneOf: ['supabase'] },
    { dimension: 'orm', oneOf: ['prisma'] },
  ],
  requires: [
    { capability: 'user-identity' },
    { capability: 'persistent-database' },
    { capability: 'server-routes' },
  ],
  questions: [
    {
      id: 'cancellation-behavior',
      prompt: 'When should access end?',
      type: 'select',
      options: ['end-of-period', 'immediately'],
      default: 'end-of-period',
    },
  ],
  tasks: [
    {
      id: 'schema',
      title: 'Schema',
      instructions: ['Add the model.'],
      targets: ['database-schema'],
    },
    {
      id: 'checkout',
      title: 'Checkout',
      instructions: ['Add checkout.'],
      targets: ['server-route', 'user-identity'],
      dependsOn: ['schema'],
    },
  ],
});

const snapshot: RepositoryMemorySnapshot = {
  repositoryPath: '/repo',
  metadata: {
    dataset: 'cliper-example',
    generatedAt: '2026-07-21T00:00:00.000Z',
  },
  memories: [
    {
      id: 'repository:app',
      type: 'repository',
      title: 'Application stack',
      content:
        'A Next.js App Router app using Supabase, Prisma, and PostgreSQL.',
      metadata: {},
      tags: [],
      relationships: [],
    },
    {
      id: 'file:schema',
      type: 'file',
      title: 'prisma/schema.prisma',
      content: 'Prisma database schema.',
      metadata: { path: 'prisma/schema.prisma' },
      tags: ['prisma', 'schema'],
      relationships: [],
    },
    {
      id: 'file:route',
      type: 'file',
      title: 'src/app/api/account/route.ts',
      content: 'Authenticated route handler.',
      metadata: { path: 'src/app/api/account/route.ts' },
      tags: ['server-route'],
      relationships: [],
    },
    {
      id: 'file:auth',
      type: 'file',
      title: 'src/lib/supabase/server.ts',
      content: 'Supabase authentication client.',
      metadata: {
        path: 'src/lib/supabase/server.ts',
        role: 'server-auth-client',
      },
      tags: ['supabase'],
      relationships: [],
    },
  ],
};

describe('PlanFeatureUseCase', () => {
  it('compiles a grounded deterministic dry-run plan', async () => {
    const useCase = createUseCase(snapshot, capsule);

    const plan = await useCase.execute({
      featureId: capsule.id,
      repositoryPath: snapshot.repositoryPath,
    });

    expect(plan.status).toBe('ready');
    expect(plan.compatibility).toEqual({ status: 'compatible' });
    expect(plan.waves).toEqual([['schema'], ['checkout']]);
    expect(plan.tasks.map(({ id, wave }) => ({ id, wave }))).toEqual([
      { id: 'schema', wave: 1 },
      { id: 'checkout', wave: 2 },
    ]);
    expect(plan.tasks.every((task) => Array.isArray(task.creates))).toBe(true);
    expect(plan.questions).toContainEqual(
      expect.objectContaining({
        id: 'cancellation-behavior',
        answer: 'end-of-period',
        source: 'default',
      }),
    );
    expect(plan.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: 'database-schema',
          status: 'resolved',
          path: 'prisma/schema.prisma',
        }),
        expect.objectContaining({
          target: 'server-route',
          status: 'resolved',
          path: 'src/app/api',
        }),
        expect.objectContaining({
          target: 'user-identity',
          status: 'resolved',
          path: 'src/lib/supabase/server.ts',
        }),
      ]),
    );
    expect(plan.provenance.source).toBe('cliper-memory');
    expect(plan.provenance).toMatchObject({
      dataset: 'cliper-example',
      generatedAt: '2026-07-21T00:00:00.000Z',
    });
    expect(plan.provenance.memoryIds).toEqual(
      [...plan.provenance.memoryIds].sort(),
    );
  });

  it('accepts and validates an explicit capsule answer', async () => {
    const plan = await createUseCase(snapshot, capsule).execute({
      featureId: capsule.id,
      repositoryPath: snapshot.repositoryPath,
      answers: { 'cancellation-behavior': 'immediately' },
    });

    expect(plan.questions[0]).toMatchObject({
      answer: 'immediately',
      source: 'provided',
    });
  });

  it('requires input when an existing target cannot be grounded', async () => {
    const capsuleWithUnknownAnchor = parseCapsule({
      ...capsule,
      tasks: [
        {
          id: 'entitlements',
          title: 'Entitlements',
          instructions: ['Extend an existing entitlement boundary.'],
          targets: ['entitlement-service'],
          creates: ['subscription-policy'],
        },
      ],
    });

    const plan = await createUseCase(
      snapshot,
      capsuleWithUnknownAnchor,
    ).execute({
      featureId: capsuleWithUnknownAnchor.id,
      repositoryPath: snapshot.repositoryPath,
    });

    expect(plan.status).toBe('needs-input');
    expect(plan.bindings).toContainEqual({
      target: 'entitlement-service',
      status: 'unresolved',
      evidenceIds: [],
    });
    expect(plan.tasks[0].creates).toEqual(['subscription-policy']);
  });

  it('fails before inspecting memory when the capsule is missing', async () => {
    const inspect = jest.fn();
    const memory: ProjectMemoryPort = { inspect };
    const registry: CapsuleRegistryPort = {
      list: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockResolvedValue(null),
    };
    const useCase = createUseCaseWithPorts(memory, registry);

    await expect(
      useCase.execute({
        featureId: 'missing-feature',
        repositoryPath: '/repo',
      }),
    ).rejects.toMatchObject<Partial<PlanFeatureError>>({
      code: 'FEATURE_NOT_FOUND',
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('rejects answers that the capsule does not define', async () => {
    await expect(
      createUseCase(snapshot, capsule).execute({
        featureId: capsule.id,
        repositoryPath: snapshot.repositoryPath,
        answers: { 'made-up-choice': true },
      }),
    ).rejects.toMatchObject<Partial<PlanFeatureError>>({
      code: 'UNKNOWN_ANSWER',
    });
  });
});

function createUseCase(
  project: RepositoryMemorySnapshot,
  registeredCapsule: typeof capsule,
): PlanFeatureUseCase {
  return createUseCaseWithPorts(
    { inspect: jest.fn().mockResolvedValue(project) },
    {
      list: jest.fn().mockResolvedValue([registeredCapsule]),
      find: jest.fn().mockResolvedValue(registeredCapsule),
    },
  );
}

function createUseCaseWithPorts(
  memory: ProjectMemoryPort,
  registry: CapsuleRegistryPort,
): PlanFeatureUseCase {
  return new PlanFeatureUseCase(
    memory,
    registry,
    new ProjectFingerprintBuilder(),
    new CapsuleMatcher(),
    new SemanticBindingService(),
    new TaskGraphCompiler(),
  );
}
