import { RepositoryMemoryRecord } from '../ports/project-memory.port';
import { ProjectFingerprintBuilder } from './project-fingerprint.builder';

function memory(
  id: string,
  fields: Partial<RepositoryMemoryRecord> = {},
): RepositoryMemoryRecord {
  return {
    id,
    type: 'architecture',
    title: '',
    content: '',
    metadata: {},
    tags: [],
    relationships: [],
    ...fields,
  };
}

describe('ProjectFingerprintBuilder', () => {
  const builder = new ProjectFingerprintBuilder();

  it('detects the MVP stack from every searchable memory field', () => {
    const fingerprint = builder.build({
      repositoryPath: '/workspace/app',
      memories: [
        memory('architecture:router', { title: 'Next.js App Router' }),
        memory('file:auth', {
          type: 'file',
          content:
            'Creates the Supabase server client for authenticated users.',
        }),
        memory('package:prisma', {
          type: 'package',
          tags: ['Prisma'],
        }),
        memory('dependency:database', {
          type: 'dependency',
          metadata: { datasource: { provider: 'postgresql' } },
        }),
        memory('file:deployment', {
          type: 'file',
          metadata: { path: 'vercel.json' },
        }),
      ],
    });

    expect(fingerprint).toMatchObject({
      repositoryPath: '/workspace/app',
      framework: {
        status: 'detected',
        value: 'nextjs-app-router',
        evidenceIds: ['architecture:router'],
      },
      auth: {
        status: 'detected',
        value: 'supabase',
        evidenceIds: ['file:auth'],
      },
      orm: {
        status: 'detected',
        value: 'prisma',
        evidenceIds: ['package:prisma'],
      },
      database: {
        status: 'detected',
        value: 'postgres',
        evidenceIds: ['dependency:database'],
      },
      deployment: {
        status: 'detected',
        value: 'vercel',
        evidenceIds: ['file:deployment'],
      },
    });
    expect(fingerprint.capabilities).toEqual([
      { id: 'user-identity', evidenceIds: ['file:auth'] },
      {
        id: 'persistent-database',
        evidenceIds: ['dependency:database', 'package:prisma'],
      },
      { id: 'server-routes', evidenceIds: ['architecture:router'] },
    ]);
  });

  it('returns unknown technologies instead of guessing from generic terms', () => {
    const fingerprint = builder.build({
      repositoryPath: '/workspace/unknown',
      memories: [
        memory('repository:generic', {
          type: 'repository',
          title: 'Web application',
          content: 'Contains authentication, a database, and deployment files.',
          tags: ['full-stack'],
        }),
      ],
    });

    expect(fingerprint).toEqual({
      repositoryPath: '/workspace/unknown',
      framework: { status: 'unknown', evidenceIds: [] },
      auth: { status: 'unknown', evidenceIds: [] },
      orm: { status: 'unknown', evidenceIds: [] },
      database: { status: 'unknown', evidenceIds: [] },
      deployment: { status: 'unknown', evidenceIds: [] },
      capabilities: [],
    });
  });

  it('reports deterministic ambiguity when explicit candidates conflict', () => {
    const memories = [
      memory('framework:next', { title: 'Next.js App Router architecture' }),
      memory('framework:nest', { content: 'Backend uses NestJS controllers.' }),
      memory('auth:supabase', { tags: ['supabase'] }),
      memory('auth:clerk', { metadata: { package: '@clerk/nextjs' } }),
      memory('orm:prisma', { content: 'Schema lives in schema.prisma.' }),
      memory('orm:drizzle', { title: 'Drizzle ORM models' }),
      memory('database:postgres', { content: 'PostgreSQL database' }),
      memory('database:mysql', { tags: ['mysql'] }),
      memory('deployment:vercel', { title: 'Vercel deployment' }),
      memory('deployment:netlify', { metadata: { file: 'netlify.toml' } }),
    ];

    const fingerprint = builder.build({
      repositoryPath: '/workspace/conflicted',
      memories: [...memories].reverse(),
    });

    expect(fingerprint.framework).toEqual({
      status: 'ambiguous',
      candidates: ['nestjs', 'nextjs-app-router'],
      evidenceIds: ['framework:nest', 'framework:next'],
    });
    expect(fingerprint.auth).toEqual({
      status: 'ambiguous',
      candidates: ['clerk', 'supabase'],
      evidenceIds: ['auth:clerk', 'auth:supabase'],
    });
    expect(fingerprint.orm).toEqual({
      status: 'ambiguous',
      candidates: ['drizzle', 'prisma'],
      evidenceIds: ['orm:drizzle', 'orm:prisma'],
    });
    expect(fingerprint.database).toEqual({
      status: 'ambiguous',
      candidates: ['mysql', 'postgres'],
      evidenceIds: ['database:mysql', 'database:postgres'],
    });
    expect(fingerprint.deployment).toEqual({
      status: 'ambiguous',
      candidates: ['netlify', 'vercel'],
      evidenceIds: ['deployment:netlify', 'deployment:vercel'],
    });
    expect(fingerprint.capabilities).toEqual([
      {
        id: 'user-identity',
        evidenceIds: ['auth:clerk', 'auth:supabase'],
      },
      {
        id: 'persistent-database',
        evidenceIds: [
          'database:mysql',
          'database:postgres',
          'orm:drizzle',
          'orm:prisma',
        ],
      },
      {
        id: 'server-routes',
        evidenceIds: ['framework:nest', 'framework:next'],
      },
    ]);
  });

  it('derives server-routes directly from route memories', () => {
    const fingerprint = builder.build({
      repositoryPath: '/workspace/custom',
      memories: [
        memory('file:api', {
          type: 'file',
          metadata: { path: 'src/api/routes/users.ts' },
          content: 'Defines API routes for users.',
        }),
      ],
    });

    expect(fingerprint.framework).toEqual({
      status: 'unknown',
      evidenceIds: [],
    });
    expect(fingerprint.capabilities).toEqual([
      { id: 'server-routes', evidenceIds: ['file:api'] },
    ]);
  });

  it('detects a TypeScript SDK and its package capabilities', () => {
    const fingerprint = builder.build({
      repositoryPath: '/workspace/sdk',
      memories: [
        memory('file:package', {
          type: 'file',
          metadata: { path: 'package.json' },
          content: 'NPM package manifest with a TypeScript build script.',
        }),
        memory('file:index', {
          type: 'file',
          metadata: { path: 'src/index.ts' },
          content: 'Public API entry point for the TypeScript SDK.',
        }),
        memory('file:tsconfig', {
          type: 'file',
          metadata: { path: 'tsconfig.json' },
        }),
        memory('file:readme', {
          type: 'file',
          metadata: { path: 'README.md' },
          content: 'SDK usage documentation.',
        }),
      ],
    });

    expect(fingerprint.framework).toEqual({
      status: 'detected',
      value: 'node-typescript-library',
      evidenceIds: ['file:index', 'file:package'],
    });
    expect(fingerprint.capabilities).toEqual([
      { id: 'package-library', evidenceIds: ['file:package'] },
      {
        id: 'typescript-source',
        evidenceIds: ['file:index', 'file:package', 'file:tsconfig'],
      },
      { id: 'public-api', evidenceIds: ['file:index'] },
      { id: 'buildable', evidenceIds: ['file:package', 'file:tsconfig'] },
      { id: 'documentation', evidenceIds: ['file:readme'] },
    ]);
  });
});
