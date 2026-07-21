import { Inject, Injectable } from '@nestjs/common';
import { Capsule, CapsuleQuestion } from '../domain/capsule';
import {
  CapsuleAnswer,
  FeaturePlan,
  PlannedQuestion,
} from '../domain/feature-plan';
import { CAPSULE_REGISTRY_PORT } from '../ports/capsule-registry.port';
import type { CapsuleRegistryPort } from '../ports/capsule-registry.port';
import { PROJECT_MEMORY_PORT } from '../ports/project-memory.port';
import type { ProjectMemoryPort } from '../ports/project-memory.port';
import { CapsuleMatcher } from '../services/capsule-matcher';
import { ProjectFingerprintBuilder } from '../services/project-fingerprint.builder';
import { SemanticBindingService } from '../services/semantic-binding.service';
import type { SemanticBinding } from '../services/semantic-binding.service';
import { TaskGraphCompiler } from '../services/task-graph.compiler';

export interface PlanFeatureInput {
  featureId: string;
  repositoryPath: string;
  request?: string;
  answers?: Record<string, CapsuleAnswer>;
}

export class PlanFeatureError extends Error {
  constructor(
    readonly code: 'FEATURE_NOT_FOUND' | 'UNKNOWN_ANSWER' | 'INVALID_ANSWER',
    message: string,
  ) {
    super(message);
    this.name = 'PlanFeatureError';
  }
}

@Injectable()
export class PlanFeatureUseCase {
  constructor(
    @Inject(PROJECT_MEMORY_PORT)
    private readonly memory: ProjectMemoryPort,
    @Inject(CAPSULE_REGISTRY_PORT)
    private readonly registry: CapsuleRegistryPort,
    private readonly fingerprintBuilder: ProjectFingerprintBuilder,
    private readonly matcher: CapsuleMatcher,
    private readonly bindingService: SemanticBindingService,
    private readonly graphCompiler: TaskGraphCompiler,
  ) {}

  async execute(input: PlanFeatureInput): Promise<FeaturePlan> {
    const capsule = await this.registry.find(input.featureId);
    if (!capsule) {
      throw new PlanFeatureError(
        'FEATURE_NOT_FOUND',
        `Feature capsule "${input.featureId}" was not found.`,
      );
    }

    const snapshot = await this.memory.inspect(input.repositoryPath);
    const fingerprint = this.fingerprintBuilder.build(snapshot);
    const compatibility = this.matcher.match(fingerprint, capsule);
    const questions = resolveQuestions(capsule, input.answers ?? {});
    const graph = this.graphCompiler.compile(capsule.tasks);
    const targets = graph.tasks.flatMap((task) => task.targets);
    const bindings = this.bindingService.bind(targets, snapshot.memories);
    const waveByTask = new Map(
      graph.waves.flatMap((wave, index) =>
        wave.map((taskId) => [taskId, index + 1] as const),
      ),
    );

    const status = planStatus(compatibility.status, questions, bindings);
    const memoryIds = new Set<string>();
    for (const dimension of [
      fingerprint.framework,
      fingerprint.auth,
      fingerprint.orm,
      fingerprint.database,
      fingerprint.deployment,
    ]) {
      dimension.evidenceIds.forEach((id) => memoryIds.add(id));
    }
    fingerprint.capabilities.forEach((capability) =>
      capability.evidenceIds.forEach((id) => memoryIds.add(id)),
    );
    bindings.forEach((binding) =>
      binding.evidenceIds.forEach((id) => memoryIds.add(id)),
    );

    return {
      schemaVersion: 1,
      mode: 'dry-run',
      status,
      repository: {
        path: snapshot.repositoryPath,
        fingerprint,
      },
      feature: {
        id: capsule.id,
        version: capsule.version,
        name: capsule.name,
        summary: capsule.summary,
        provides: capsule.provides,
      },
      ...(input.request?.trim() ? { request: input.request.trim() } : {}),
      compatibility,
      questions,
      bindings,
      tasks: graph.tasks.map((task) => ({
        ...task,
        wave: waveByTask.get(task.id)!,
      })),
      waves: graph.waves,
      acceptance: capsule.acceptance,
      provenance: {
        source: 'cliper-memory',
        memoryIds: [...memoryIds].sort(),
        ...(snapshot.metadata?.dataset
          ? { dataset: snapshot.metadata.dataset }
          : {}),
        ...(snapshot.metadata?.generatedAt
          ? { generatedAt: snapshot.metadata.generatedAt }
          : {}),
      },
    };
  }
}

function resolveQuestions(
  capsule: Capsule,
  answers: Record<string, CapsuleAnswer>,
): PlannedQuestion[] {
  const questions = new Map(
    capsule.questions.map((question) => [question.id, question]),
  );

  for (const answerId of Object.keys(answers)) {
    if (!questions.has(answerId)) {
      throw new PlanFeatureError(
        'UNKNOWN_ANSWER',
        `Capsule "${capsule.id}" does not define question "${answerId}".`,
      );
    }
  }

  return capsule.questions.map((question) => {
    if (Object.hasOwn(answers, question.id)) {
      const answer = answers[question.id];
      validateAnswer(question, answer);
      return plannedQuestion(question, answer, 'provided');
    }

    if (question.default !== undefined) {
      validateAnswer(question, question.default);
      return plannedQuestion(question, question.default, 'default');
    }

    return plannedQuestion(question, undefined, 'unanswered');
  });
}

function validateAnswer(
  question: CapsuleQuestion,
  answer: CapsuleAnswer,
): void {
  const validType =
    question.type === 'boolean'
      ? typeof answer === 'boolean'
      : typeof answer === 'string';
  const validOption =
    question.type !== 'select' ||
    (typeof answer === 'string' && question.options?.includes(answer));

  if (!validType || !validOption) {
    throw new PlanFeatureError(
      'INVALID_ANSWER',
      `Invalid answer for "${question.id}".`,
    );
  }
}

function plannedQuestion(
  question: CapsuleQuestion,
  answer: CapsuleAnswer | undefined,
  source: PlannedQuestion['source'],
): PlannedQuestion {
  return {
    id: question.id,
    prompt: question.prompt,
    type: question.type,
    ...(question.options ? { options: question.options } : {}),
    ...(answer !== undefined ? { answer } : {}),
    source,
  };
}

function planStatus(
  compatibilityStatus: FeaturePlan['compatibility']['status'],
  questions: PlannedQuestion[],
  bindings: SemanticBinding[],
): FeaturePlan['status'] {
  if (compatibilityStatus === 'incompatible') return 'incompatible';
  if (
    compatibilityStatus === 'needs-input' ||
    questions.some((question) => question.source === 'unanswered') ||
    bindings.some((binding) => binding.status !== 'resolved')
  ) {
    return 'needs-input';
  }
  return 'ready';
}
