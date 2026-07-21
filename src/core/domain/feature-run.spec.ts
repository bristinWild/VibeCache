import { FeatureRunWaveResultSchema } from './feature-run';

describe('FeatureRunWaveResultSchema', () => {
  it('does not allow a completed wave with skipped verification', () => {
    const timestamp = '2026-07-21T12:00:00.000Z';
    const result = FeatureRunWaveResultSchema.safeParse({
      wave: 1,
      taskIds: ['schema'],
      status: 'completed',
      agents: [
        {
          name: 'codex',
          status: 'completed',
          taskIds: ['schema'],
          summary: 'Implemented schema.',
          changedFiles: ['schema.prisma'],
          startedAt: timestamp,
          completedAt: timestamp,
        },
      ],
      verification: {
        status: 'skipped',
        summary: 'Not run.',
        checks: [],
        verifiedAt: timestamp,
      },
      startedAt: timestamp,
      completedAt: timestamp,
    });

    expect(result.success).toBe(false);
  });
});
