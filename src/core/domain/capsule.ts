import { z } from 'zod';

const IdentifierSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const CompatibilityRequirementSchema = z.object({
  dimension: z.enum(['framework', 'auth', 'orm', 'database', 'deployment']),
  oneOf: z.array(IdentifierSchema).min(1),
  required: z.boolean().default(true),
});

const CapabilityRequirementSchema = z.object({
  capability: IdentifierSchema,
  required: z.boolean().default(true),
});

const CapsuleQuestionSchema = z.object({
  id: IdentifierSchema,
  prompt: z.string().min(1),
  type: z.enum(['select', 'text', 'boolean']),
  options: z.array(z.string().min(1)).optional(),
  default: z.union([z.string(), z.boolean()]).optional(),
});

export const VerificationCheckSchema = z.object({
  id: IdentifierSchema,
  executable: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
});

export const CapsuleTaskSchema = z.object({
  id: IdentifierSchema,
  title: z.string().min(1),
  instructions: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(IdentifierSchema).default([]),
  // Existing repository concepts that must resolve to grounded paths.
  targets: z.array(IdentifierSchema).default([]),
  // New concepts the implementation is expected to introduce.
  creates: z.array(IdentifierSchema).default([]),
  verification: z.array(VerificationCheckSchema).default([]),
});

export const CapsuleSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdentifierSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    name: z.string().min(1),
    summary: z.string().min(1),
    provides: z.array(IdentifierSchema).min(1),
    compatibility: z.array(CompatibilityRequirementSchema).default([]),
    requires: z.array(CapabilityRequirementSchema).default([]),
    questions: z.array(CapsuleQuestionSchema).default([]),
    tasks: z.array(CapsuleTaskSchema).min(1),
    acceptance: z.array(VerificationCheckSchema).default([]),
  })
  .superRefine((capsule, context) => {
    const ids = new Set<string>();
    for (const task of capsule.tasks) {
      if (ids.has(task.id)) {
        context.addIssue({
          code: 'custom',
          path: ['tasks'],
          message: `Duplicate task id: ${task.id}`,
        });
      }
      ids.add(task.id);
    }

    for (const question of capsule.questions) {
      if (question.type === 'select' && !question.options?.length) {
        context.addIssue({
          code: 'custom',
          path: ['questions', question.id, 'options'],
          message: 'Select questions require at least one option',
        });
      }
    }
  });

export type Capsule = z.infer<typeof CapsuleSchema>;
export type CapsuleTask = z.infer<typeof CapsuleTaskSchema>;
export type CapsuleQuestion = z.infer<typeof CapsuleQuestionSchema>;
export type CapsuleRequirement = z.infer<typeof CompatibilityRequirementSchema>;
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;

export function parseCapsule(input: unknown): Capsule {
  return CapsuleSchema.parse(input);
}
