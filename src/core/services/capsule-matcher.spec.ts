import { Capsule } from '../domain/capsule';
import { ProjectFingerprint } from '../domain/project-fingerprint';
import { CapsuleMatcher } from './capsule-matcher';

const capsule = {
  schemaVersion: 1,
  id: 'stripe-subscriptions',
  version: '0.1.0',
  name: 'Stripe subscriptions',
  summary: 'Adds subscriptions.',
  provides: ['subscription-billing'],
  compatibility: [
    {
      dimension: 'framework',
      oneOf: ['nextjs-app-router'],
      required: true,
    },
  ],
  requires: [{ capability: 'user-identity', required: true }],
  questions: [],
  tasks: [
    {
      id: 'schema',
      title: 'Schema',
      instructions: ['Add schema'],
      dependsOn: [],
      targets: [],
      creates: [],
      verification: [],
    },
  ],
  acceptance: [],
} satisfies Capsule;

function fingerprint(
  framework: ProjectFingerprint['framework'],
): ProjectFingerprint {
  return {
    repositoryPath: '/repo',
    framework,
    auth: { status: 'unknown', evidenceIds: [] },
    orm: { status: 'unknown', evidenceIds: [] },
    database: { status: 'unknown', evidenceIds: [] },
    deployment: { status: 'unknown', evidenceIds: [] },
    capabilities: [{ id: 'user-identity', evidenceIds: ['auth'] }],
  };
}

describe('CapsuleMatcher', () => {
  const matcher = new CapsuleMatcher();

  it('matches a supported stack with required capabilities', () => {
    expect(
      matcher.match(
        fingerprint({
          status: 'detected',
          value: 'nextjs-app-router',
          evidenceIds: ['package:next'],
        }),
        capsule,
      ),
    ).toEqual({ status: 'compatible' });
  });

  it('reports a known unsupported framework as incompatible', () => {
    expect(
      matcher.match(
        fingerprint({
          status: 'detected',
          value: 'nestjs',
          evidenceIds: ['package:nest'],
        }),
        capsule,
      ),
    ).toMatchObject({
      status: 'incompatible',
      reasons: [{ code: 'unsupported-technology', actual: 'nestjs' }],
    });
  });

  it('asks for input instead of guessing when evidence is ambiguous', () => {
    expect(
      matcher.match(
        fingerprint({
          status: 'ambiguous',
          candidates: ['nextjs-app-router', 'nextjs-pages-router'],
          evidenceIds: ['package:next'],
        }),
        capsule,
      ),
    ).toMatchObject({
      status: 'needs-input',
      missing: [{ code: 'ambiguous-technology' }],
    });
  });
});
