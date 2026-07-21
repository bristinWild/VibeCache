import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const FEATURE_RUN_SCHEMA_VERSION = 1 as const;
export const FEATURE_RUN_ID_PATTERN = /^\d{8}t\d{9}z-[a-f0-9]{20}$/;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

const NonEmptyStringSchema = z.string().trim().min(1);
const IsoTimestampSchema = z.iso.datetime({ offset: true });
const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const RepositoryRelativePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isSafeRepositoryRelativePath, {
    message: 'Binding paths must be safe repository-relative paths.',
  });

export const AgentExecutionSummarySchema = z
  .object({
    name: NonEmptyStringSchema,
    model: NonEmptyStringSchema.optional(),
    sessionId: NonEmptyStringSchema.optional(),
    status: z.enum(['completed', 'failed']),
    taskIds: z.array(IdentifierSchema),
    summary: NonEmptyStringSchema,
    changedFiles: z.array(RepositoryRelativePathSchema).default([]),
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((agent, context) => {
    assertChronological(agent.startedAt, agent.completedAt, context, [
      'completedAt',
    ]);
  });

export const VerificationCheckSummarySchema = z
  .object({
    id: IdentifierSchema,
    status: z.enum(['passed', 'failed', 'timed_out', 'error']),
    durationMs: z.number().finite().nonnegative(),
    summary: NonEmptyStringSchema.optional(),
  })
  .strict();

export const VerificationSummarySchema = z
  .object({
    status: z.enum(['passed', 'failed', 'skipped']),
    summary: NonEmptyStringSchema,
    checks: z.array(VerificationCheckSummarySchema),
    verifiedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((verification, context) => {
    if (
      verification.status === 'passed' &&
      verification.checks.some((check) => check.status !== 'passed')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['checks'],
        message: 'Passed verification cannot contain a failed check.',
      });
    }

    if (verification.status === 'skipped' && verification.checks.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['checks'],
        message: 'Skipped verification cannot contain check results.',
      });
    }
  });

export const FeatureRunWaveResultSchema = z
  .object({
    wave: z.number().int().positive(),
    taskIds: z.array(IdentifierSchema).min(1),
    status: z.enum(['completed', 'failed']),
    agents: z.array(AgentExecutionSummarySchema).min(1),
    verification: VerificationSummarySchema,
    startedAt: IsoTimestampSchema,
    completedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((wave, context) => {
    assertChronological(wave.startedAt, wave.completedAt, context, [
      'completedAt',
    ]);

    const taskIds = new Set<string>();
    for (const taskId of wave.taskIds) {
      if (taskIds.has(taskId)) {
        context.addIssue({
          code: 'custom',
          path: ['taskIds'],
          message: `Duplicate task id in wave: ${taskId}.`,
        });
      }
      taskIds.add(taskId);
    }

    if (
      wave.status === 'completed' &&
      (wave.agents.some((agent) => agent.status !== 'completed') ||
        wave.verification.status !== 'passed')
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'A completed wave requires completed agents and passed verification.',
      });
    }

    if (
      wave.status === 'failed' &&
      wave.agents.every((agent) => agent.status === 'completed') &&
      wave.verification.status !== 'failed'
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'A failed wave must identify an agent or verification failure.',
      });
    }
  });

export const FeatureRunFailureSchema = z
  .object({
    code: IdentifierSchema,
    message: NonEmptyStringSchema,
    recoverable: z.boolean(),
    wave: z.number().int().positive().optional(),
    taskId: IdentifierSchema.optional(),
    occurredAt: IsoTimestampSchema,
  })
  .strict();

export const FeatureRunSchema = z
  .object({
    schemaVersion: z.literal(FEATURE_RUN_SCHEMA_VERSION),
    runId: z.string().regex(FEATURE_RUN_ID_PATTERN),
    featureId: IdentifierSchema,
    request: NonEmptyStringSchema.optional(),
    capsule: z
      .object({
        id: IdentifierSchema,
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        digest: NonEmptyStringSchema.optional(),
      })
      .strict(),
    repository: z
      .object({
        path: z.string().trim().min(1).refine(isAbsolute, {
          message: 'Repository path must be absolute.',
        }),
        startingCommit: z.string().regex(/^[0-9a-f]{7,64}$/),
      })
      .strict(),
    status: z.enum(['running', 'failed', 'installed']),
    currentWave: z.number().int().positive().nullable(),
    nextWave: z.number().int().positive().nullable(),
    choices: z.record(z.string().min(1), JsonValueSchema),
    bindings: z.record(z.string().min(1), RepositoryRelativePathSchema),
    waveResults: z.array(FeatureRunWaveResultSchema),
    timestamps: z
      .object({
        createdAt: IsoTimestampSchema,
        startedAt: IsoTimestampSchema,
        updatedAt: IsoTimestampSchema,
        completedAt: IsoTimestampSchema.optional(),
      })
      .strict(),
    failure: FeatureRunFailureSchema.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.featureId !== run.capsule.id) {
      context.addIssue({
        code: 'custom',
        path: ['capsule', 'id'],
        message: 'Capsule id must match feature id.',
      });
    }

    assertChronological(
      run.timestamps.createdAt,
      run.timestamps.startedAt,
      context,
      ['timestamps', 'startedAt'],
    );
    assertChronological(
      run.timestamps.startedAt,
      run.timestamps.updatedAt,
      context,
      ['timestamps', 'updatedAt'],
    );
    if (run.timestamps.completedAt) {
      assertChronological(
        run.timestamps.startedAt,
        run.timestamps.completedAt,
        context,
        ['timestamps', 'completedAt'],
      );
    }

    for (let index = 0; index < run.waveResults.length; index += 1) {
      const result = run.waveResults[index];
      const expectedWave = index + 1;
      if (result.wave !== expectedWave) {
        context.addIssue({
          code: 'custom',
          path: ['waveResults', index, 'wave'],
          message: `Wave results must be contiguous and ordered; expected wave ${expectedWave}.`,
        });
      }
    }

    if (run.status === 'running') {
      if (run.failure || run.timestamps.completedAt) {
        context.addIssue({
          code: 'custom',
          message: 'A running feature run cannot have failure/completion data.',
        });
      }
      if (run.nextWave === null) {
        context.addIssue({
          code: 'custom',
          path: ['nextWave'],
          message: 'A running feature run must identify its next wave.',
        });
      }
    }

    if (run.status === 'failed') {
      if (!run.failure || !run.timestamps.completedAt) {
        context.addIssue({
          code: 'custom',
          message: 'A failed feature run requires failure/completion data.',
        });
      }
      if (run.nextWave === null) {
        context.addIssue({
          code: 'custom',
          path: ['nextWave'],
          message: 'A failed feature run must retain its resume wave.',
        });
      }
    }

    if (run.status === 'installed') {
      if (run.failure || !run.timestamps.completedAt) {
        context.addIssue({
          code: 'custom',
          message:
            'An installed feature run requires completion data and cannot have failure data.',
        });
      }
      if (run.currentWave !== null || run.nextWave !== null) {
        context.addIssue({
          code: 'custom',
          message: 'An installed feature run cannot retain current/next waves.',
        });
      }
      if (
        run.waveResults.some(
          (result) =>
            result.status !== 'completed' ||
            result.verification.status !== 'passed',
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['waveResults'],
          message: 'An installed feature run cannot contain failed waves.',
        });
      }
    }

    if (
      run.currentWave !== null &&
      run.nextWave !== null &&
      run.nextWave < run.currentWave
    ) {
      context.addIssue({
        code: 'custom',
        path: ['nextWave'],
        message: 'The next wave cannot precede the current wave.',
      });
    }
  });

export type AgentExecutionSummary = z.infer<typeof AgentExecutionSummarySchema>;
export type VerificationCheckSummary = z.infer<
  typeof VerificationCheckSummarySchema
>;
export type VerificationSummary = z.infer<typeof VerificationSummarySchema>;
export type FeatureRunWaveResult = z.infer<typeof FeatureRunWaveResultSchema>;
export type FeatureRunFailure = z.infer<typeof FeatureRunFailureSchema>;
export type FeatureRun = z.infer<typeof FeatureRunSchema>;

export function parseFeatureRun(input: unknown): FeatureRun {
  return FeatureRunSchema.parse(input);
}

function assertChronological(
  earlier: string,
  later: string,
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (Date.parse(later) < Date.parse(earlier)) {
    context.addIssue({
      code: 'custom',
      path,
      message: 'Timestamp cannot precede the corresponding start time.',
    });
  }
}

function isSafeRepositoryRelativePath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  if (
    isAbsolute(value) ||
    normalized.startsWith('/') ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.includes('\0')
  ) {
    return false;
  }

  return normalized
    .split('/')
    .every(
      (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
    );
}
