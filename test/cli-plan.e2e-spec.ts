import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(__dirname, '..');
const fixtureRoot = resolve(__dirname, 'fixtures/next-supabase-prisma');
const protectedFixtureFiles = [
  'prisma/schema.prisma',
  'src/app/api/billing/route.ts',
  'src/lib/supabase/server.ts',
].map((path) => resolve(fixtureRoot, path));

describe('VibeCache CLI dry-run', () => {
  jest.setTimeout(30_000);

  it('compiles Stripe subscriptions from real local Cliper memory without writing to the app', () => {
    const before = protectedFixtureFiles.map((path) =>
      readFileSync(path, 'utf8'),
    );
    expect(existsSync(resolve(fixtureRoot, '.vibe'))).toBe(false);

    const stdout = execFileSync(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        'src/cli.ts',
        'add',
        'stripe-subscriptions',
        '--path',
        fixtureRoot,
        '--dry-run',
        '--json',
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
      },
    );
    const plan = JSON.parse(stdout) as {
      status: string;
      mode: string;
      repository: {
        fingerprint: Record<string, { status: string; value?: string }>;
      };
      waves: string[][];
      questions: Array<{ id: string; answer?: string; source: string }>;
      bindings: Array<{ target: string; status: string; path?: string }>;
      provenance: { source: string; memoryIds: string[] };
    };

    expect(plan).toMatchObject({
      status: 'ready',
      mode: 'dry-run',
      repository: {
        fingerprint: {
          framework: { status: 'detected', value: 'nextjs-app-router' },
          auth: { status: 'detected', value: 'supabase' },
          orm: { status: 'detected', value: 'prisma' },
          database: { status: 'detected', value: 'postgres' },
        },
      },
      waves: [['subscription-schema'], ['checkout', 'webhook'], ['verify']],
      provenance: { source: 'cliper-memory' },
    });
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
    expect(plan.provenance.memoryIds.length).toBeGreaterThan(5);

    expect(existsSync(resolve(fixtureRoot, '.vibe'))).toBe(false);
    expect(
      protectedFixtureFiles.map((path) => readFileSync(path, 'utf8')),
    ).toEqual(before);
  });
});
