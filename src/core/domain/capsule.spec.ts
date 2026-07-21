import { parseCapsule } from './capsule';

const validCapsule = {
  schemaVersion: 1,
  id: 'stripe-subscriptions',
  version: '0.1.0',
  name: 'Stripe subscriptions',
  summary: 'Adds recurring billing.',
  provides: ['subscription-billing'],
  compatibility: [{ dimension: 'framework', oneOf: ['nextjs-app-router'] }],
  requires: [{ capability: 'user-identity' }],
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
      id: 'subscription-schema',
      title: 'Add the subscription schema',
      instructions: ['Add a subscription model.'],
    },
  ],
};

describe('CapsuleSchema', () => {
  it('parses a valid capsule and supplies collection defaults', () => {
    const capsule = parseCapsule(validCapsule);

    expect(capsule.tasks[0]).toMatchObject({
      dependsOn: [],
      targets: [],
      creates: [],
      verification: [],
    });
    expect(capsule.acceptance).toEqual([]);
  });

  it('rejects duplicate task identifiers', () => {
    expect(() =>
      parseCapsule({
        ...validCapsule,
        tasks: [validCapsule.tasks[0], validCapsule.tasks[0]],
      }),
    ).toThrow('Duplicate task id');
  });

  it('requires options for select questions', () => {
    expect(() =>
      parseCapsule({
        ...validCapsule,
        questions: [
          {
            id: 'plan',
            prompt: 'Which plan?',
            type: 'select',
          },
        ],
      }),
    ).toThrow('Select questions require');
  });
});
