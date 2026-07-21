import { Capsule, CapsuleTask, VerificationCheck } from './capsule';
import { ProjectFingerprint } from './project-fingerprint';
import { CompatibilityResult } from '../services/capsule-matcher';
import { SemanticBinding } from '../services/semantic-binding.service';

export type CapsuleAnswer = string | boolean;

export interface PlannedQuestion {
  id: string;
  prompt: string;
  type: 'select' | 'text' | 'boolean';
  options?: string[];
  answer?: CapsuleAnswer;
  source: 'provided' | 'default' | 'unanswered';
}

export interface PlannedTask extends CapsuleTask {
  wave: number;
}

export interface FeaturePlan {
  schemaVersion: 1;
  mode: 'dry-run';
  status: 'ready' | 'needs-input' | 'incompatible';
  repository: {
    path: string;
    fingerprint: ProjectFingerprint;
  };
  feature: Pick<Capsule, 'id' | 'version' | 'name' | 'summary' | 'provides'>;
  compatibility: CompatibilityResult;
  questions: PlannedQuestion[];
  bindings: SemanticBinding[];
  tasks: PlannedTask[];
  waves: string[][];
  acceptance: VerificationCheck[];
  provenance: {
    source: 'cliper-memory';
    memoryIds: string[];
    dataset?: string;
    generatedAt?: string;
  };
}
