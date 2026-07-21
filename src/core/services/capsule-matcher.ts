import { Capsule } from '../domain/capsule';
import {
  ProjectFingerprint,
  TechnologyDimension,
} from '../domain/project-fingerprint';

export type CompatibilityResult =
  | { status: 'compatible' }
  | {
      status: 'incompatible';
      reasons: Array<{
        code: 'unsupported-technology' | 'missing-capability';
        subject: string;
        expected: string[];
        actual?: string;
      }>;
    }
  | {
      status: 'needs-input';
      missing: Array<{
        code: 'unknown-technology' | 'ambiguous-technology';
        subject: string;
        expected: string[];
        candidates?: string[];
      }>;
    };

export class CapsuleMatcher {
  match(
    fingerprint: ProjectFingerprint,
    capsule: Capsule,
  ): CompatibilityResult {
    const reasons: Extract<
      CompatibilityResult,
      { status: 'incompatible' }
    >['reasons'] = [];
    const missing: Extract<
      CompatibilityResult,
      { status: 'needs-input' }
    >['missing'] = [];

    for (const requirement of capsule.compatibility) {
      const detection = fingerprint[requirement.dimension];
      if (detection.status === 'detected') {
        if (!requirement.oneOf.includes(detection.value)) {
          reasons.push({
            code: 'unsupported-technology',
            subject: requirement.dimension,
            expected: requirement.oneOf,
            actual: detection.value,
          });
        }
        continue;
      }

      if (!requirement.required) continue;

      missing.push({
        code:
          detection.status === 'unknown'
            ? 'unknown-technology'
            : 'ambiguous-technology',
        subject: requirement.dimension,
        expected: requirement.oneOf,
        ...(detection.status === 'ambiguous'
          ? { candidates: detection.candidates }
          : {}),
      });
    }

    const capabilities = new Set(
      fingerprint.capabilities.map((capability) => capability.id),
    );
    for (const requirement of capsule.requires) {
      if (requirement.required && !capabilities.has(requirement.capability)) {
        reasons.push({
          code: 'missing-capability',
          subject: requirement.capability,
          expected: [requirement.capability],
        });
      }
    }

    if (reasons.length > 0) return { status: 'incompatible', reasons };
    if (missing.length > 0) return { status: 'needs-input', missing };
    return { status: 'compatible' };
  }
}

export function technology(
  fingerprint: ProjectFingerprint,
  dimension: TechnologyDimension,
) {
  return fingerprint[dimension];
}
