import { RepositoryMemoryRecord } from '../ports/project-memory.port';
import { SemanticBindingService } from './semantic-binding.service';

const memory = (
  id: string,
  path: string,
  overrides: Partial<RepositoryMemoryRecord> = {},
): RepositoryMemoryRecord => ({
  id,
  type: 'file',
  title: path,
  content: '',
  metadata: { path },
  tags: [],
  relationships: [],
  ...overrides,
});

describe('SemanticBindingService', () => {
  const service = new SemanticBindingService();

  it('resolves known capsule concepts from repository memory', () => {
    const memories: RepositoryMemoryRecord[] = [
      memory('schema', 'prisma/schema.prisma'),
      memory('route', 'src/app/api/billing/route.ts', {
        tags: ['server-route'],
      }),
      memory('auth', 'src/lib/supabase/server.ts', {
        metadata: {
          path: 'src/lib/supabase/server.ts',
          role: 'server-auth-client',
        },
      }),
    ];

    expect(
      service.bind(
        ['database-schema', 'server-route-root', 'auth-boundary'],
        memories,
      ),
    ).toEqual([
      {
        target: 'database-schema',
        status: 'resolved',
        path: 'prisma/schema.prisma',
        evidenceIds: ['schema'],
      },
      {
        target: 'server-route-root',
        status: 'resolved',
        path: 'src/app/api',
        evidenceIds: ['route'],
      },
      {
        target: 'auth-boundary',
        status: 'resolved',
        path: 'src/lib/supabase/server.ts',
        evidenceIds: ['auth'],
      },
    ]);
  });

  it('reports equally strong candidates as ambiguous', () => {
    const bindings = service.bind(
      ['auth-boundary'],
      [
        memory('auth-a', 'src/lib/auth/server.ts', {
          metadata: { path: 'src/lib/auth/server.ts', role: 'auth-client' },
        }),
        memory('auth-b', 'src/lib/session/server.ts', {
          metadata: { path: 'src/lib/session/server.ts', role: 'auth-client' },
        }),
      ],
    );

    expect(bindings[0]).toMatchObject({
      target: 'auth-boundary',
      status: 'ambiguous',
      candidates: ['src/lib/auth/server.ts', 'src/lib/session/server.ts'],
    });
  });

  it('does not guess an unknown location', () => {
    expect(service.bind(['database-schema'], [])).toEqual([
      {
        target: 'database-schema',
        status: 'unresolved',
        evidenceIds: [],
      },
    ]);
  });
});
