import {
  ProjectFingerprint,
  TechnologyDetection,
  TechnologyDimension,
} from '../domain/project-fingerprint';
import {
  RepositoryMemoryRecord,
  RepositoryMemorySnapshot,
} from '../ports/project-memory.port';

interface CandidateRule {
  value: string;
  patterns: RegExp[];
}

type CandidateEvidence = Map<string, Set<string>>;

const TECHNOLOGY_RULES: Record<TechnologyDimension, CandidateRule[]> = {
  framework: [
    {
      value: 'nextjs-app-router',
      patterns: [
        /\bnext(?:\.?js)?[\s/-]+app[\s-]+router\b/,
        /\bapp[\s-]+router\b/,
        /(?:^|[\s"'])app\/api\//,
      ],
    },
    {
      value: 'nextjs-pages-router',
      patterns: [
        /\bnext(?:\.?js)?[\s/-]+pages[\s-]+router\b/,
        /\bpages[\s-]+router\b/,
        /(?:^|[\s"'])pages\/api\//,
      ],
    },
    {
      value: 'nestjs',
      patterns: [/\bnestjs\b/, /@nestjs\//],
    },
    {
      value: 'remix',
      patterns: [/\bremix(?:\.run)?\b/, /@remix-run\//],
    },
  ],
  auth: [
    {
      value: 'supabase',
      patterns: [/\bsupabase\b/, /@supabase\//],
    },
    {
      value: 'clerk',
      patterns: [/\bclerk\b/, /@clerk\//],
    },
    {
      value: 'auth0',
      patterns: [/\bauth0\b/, /@auth0\//],
    },
    {
      value: 'nextauth',
      patterns: [/\bnext-auth\b/, /\bnextauth\b/, /\bauth\.js\b/],
    },
    {
      value: 'firebase-auth',
      patterns: [/\bfirebase[\s-]+auth(?:entication)?\b/],
    },
  ],
  orm: [
    {
      value: 'prisma',
      patterns: [/\bprisma\b/, /@prisma\//, /\bschema\.prisma\b/],
    },
    {
      value: 'drizzle',
      patterns: [/\bdrizzle(?:-orm)?\b/],
    },
    {
      value: 'typeorm',
      patterns: [/\btypeorm\b/],
    },
    {
      value: 'sequelize',
      patterns: [/\bsequelize\b/],
    },
  ],
  database: [
    {
      value: 'postgres',
      patterns: [
        /\bpostgres(?:ql)?\b/,
        /\bpostgresql:\/\//,
        /provider[\s"':=]+postgresql\b/,
      ],
    },
    {
      value: 'mysql',
      patterns: [/\bmysql\b/, /\bmysql:\/\//],
    },
    {
      value: 'sqlite',
      patterns: [/\bsqlite\b/, /\bfile:[^\s"']*\.db\b/],
    },
    {
      value: 'mongodb',
      patterns: [/\bmongodb\b/, /\bmongodb(?:\+srv)?:\/\//],
    },
  ],
  deployment: [
    {
      value: 'vercel',
      patterns: [/\bvercel\b/, /\bvercel\.json\b/],
    },
    {
      value: 'netlify',
      patterns: [/\bnetlify\b/, /\bnetlify\.toml\b/],
    },
    {
      value: 'railway',
      patterns: [/\brailway\b/, /\brailway\.json\b/],
    },
    {
      value: 'flyio',
      patterns: [/\bfly\.io\b/, /\bfly\.toml\b/],
    },
  ],
};

const SERVER_ROUTE_PATTERNS = [
  /\bserver[\s-]+routes?\b/,
  /\bapi[\s-]+routes?\b/,
  /\broute[\s-]+handlers?\b/,
  /(?:^|[\s"'])app\/api\//,
  /(?:^|[\s"'])pages\/api\//,
];

const SERVER_ROUTE_FRAMEWORKS = new Set([
  'nextjs-app-router',
  'nextjs-pages-router',
  'nestjs',
  'remix',
]);

function flattenMetadata(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value === 'number') {
    return [String(value)];
  }
  if (typeof value === 'boolean') return [value ? 'true' : 'false'];
  if (Array.isArray(value)) return value.flatMap(flattenMetadata);
  if (typeof value !== 'object') return [];

  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, nested]) => [key, ...flattenMetadata(nested)]);
}

function searchableText(memory: RepositoryMemoryRecord): string {
  return [
    memory.title,
    memory.content,
    ...memory.tags,
    ...flattenMetadata(memory.metadata),
  ]
    .join(' ')
    .toLowerCase();
}

function collectEvidence(
  memories: RepositoryMemoryRecord[],
  rules: CandidateRule[],
): CandidateEvidence {
  const evidence: CandidateEvidence = new Map();

  for (const memory of memories) {
    const text = searchableText(memory);
    for (const rule of rules) {
      if (!rule.patterns.some((pattern) => pattern.test(text))) continue;
      const ids = evidence.get(rule.value) ?? new Set<string>();
      ids.add(memory.id);
      evidence.set(rule.value, ids);
    }
  }

  return evidence;
}

function sortedEvidence(evidence: CandidateEvidence): string[] {
  return [...new Set([...evidence.values()].flatMap((ids) => [...ids]))].sort();
}

function toDetection(evidence: CandidateEvidence): TechnologyDetection {
  const candidates = [...evidence.keys()].sort();

  if (candidates.length === 0) {
    return { status: 'unknown', evidenceIds: [] };
  }

  if (candidates.length === 1) {
    return {
      status: 'detected',
      value: candidates[0],
      evidenceIds: [...(evidence.get(candidates[0]) ?? [])].sort(),
    };
  }

  return {
    status: 'ambiguous',
    candidates,
    evidenceIds: sortedEvidence(evidence),
  };
}

function matchingMemoryIds(
  memories: RepositoryMemoryRecord[],
  patterns: RegExp[],
): string[] {
  return memories
    .filter((memory) => {
      const text = searchableText(memory);
      return patterns.some((pattern) => pattern.test(text));
    })
    .map((memory) => memory.id)
    .sort();
}

function addCapability(
  capabilities: ProjectFingerprint['capabilities'],
  id: string,
  evidenceIds: string[],
): void {
  if (evidenceIds.length === 0) return;
  capabilities.push({ id, evidenceIds: [...new Set(evidenceIds)].sort() });
}

export class ProjectFingerprintBuilder {
  build(snapshot: RepositoryMemorySnapshot): ProjectFingerprint {
    const analyses = Object.fromEntries(
      (Object.keys(TECHNOLOGY_RULES) as TechnologyDimension[]).map(
        (dimension) => [
          dimension,
          collectEvidence(snapshot.memories, TECHNOLOGY_RULES[dimension]),
        ],
      ),
    ) as Record<TechnologyDimension, CandidateEvidence>;

    const framework = toDetection(analyses.framework);
    const auth = toDetection(analyses.auth);
    const orm = toDetection(analyses.orm);
    const database = toDetection(analyses.database);
    const deployment = toDetection(analyses.deployment);
    const capabilities: ProjectFingerprint['capabilities'] = [];

    addCapability(capabilities, 'user-identity', sortedEvidence(analyses.auth));
    addCapability(capabilities, 'persistent-database', [
      ...sortedEvidence(analyses.orm),
      ...sortedEvidence(analyses.database),
    ]);

    const frameworkRouteEvidence = [...analyses.framework.entries()]
      .filter(([candidate]) => SERVER_ROUTE_FRAMEWORKS.has(candidate))
      .flatMap(([, evidenceIds]) => [...evidenceIds]);
    addCapability(capabilities, 'server-routes', [
      ...frameworkRouteEvidence,
      ...matchingMemoryIds(snapshot.memories, SERVER_ROUTE_PATTERNS),
    ]);

    return {
      repositoryPath: snapshot.repositoryPath,
      framework,
      auth,
      orm,
      database,
      deployment,
      capabilities,
    };
  }
}
