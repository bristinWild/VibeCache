#!/usr/bin/env node
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { CliAppModule } from './cli-app.module';
import { CAPSULE_REGISTRY_PORT } from './core/ports/capsule-registry.port';
import type { CapsuleRegistryPort } from './core/ports/capsule-registry.port';
import { PlanFeatureUseCase } from './core/use-cases/plan-feature.use-case';
import { VIBECACHE_VERSION } from './version';
import { loadMarketplaceIndex } from './marketplace/marketplace-index';

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const TOOL = {
  name: 'vibe_plan',
  description:
    'Use Cliper repository memory and a VibeCache feature capsule to produce a grounded implementation plan for the current coding task. If local Cliper memory is missing, VibeCache enables the local-json provider and initializes it automatically. The calling agent remains responsible for editing files.',
  inputSchema: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description: 'The user request to implement.',
      },
      feature: {
        type: 'string',
        description:
          'Optional VibeCache capsule id, such as dark-theme or wallet-connect-tab.',
      },
      repositoryPath: {
        type: 'string',
        description:
          'Optional absolute repository path. Defaults to the MCP process directory.',
      },
    },
    required: ['request'],
    additionalProperties: false,
  },
};

const CATALOG_TOOL = {
  name: 'vibe_catalog',
  description:
    'List approved VibeCache community capsules by category or search term.',
  inputSchema: {
    type: 'object',
    properties: {
      category: { type: 'string', description: 'Optional category filter.' },
      search: {
        type: 'string',
        description: 'Optional id/category search term.',
      },
    },
    additionalProperties: false,
  },
};

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function errorResponse(
  id: string | number | null | undefined,
  code: number,
  message: string,
) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function inferFeature(
  request: string,
  available: string[],
): string | undefined {
  const text = request.toLowerCase();
  const candidates: Array<[RegExp, string]> = [
    [/dark\s*theme|dark\s*mode|theme/, 'dark-theme'],
    [/wallet\s*connect|wallet\s*tab|crypto\s*wallet/, 'wallet-connect-tab'],
    [/stripe|subscription|recurring\s*billing/, 'stripe-subscriptions'],
    [/sdk|typescript\s*(?:library|package)/, 'sdk-feature'],
  ];
  return candidates.find(
    ([pattern, feature]) => available.includes(feature) && pattern.test(text),
  )?.[1];
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(CliAppModule, {
    logger: false,
  });
  const planner = app.get(PlanFeatureUseCase);
  const registry = app.get<CapsuleRegistryPort>(CAPSULE_REGISTRY_PORT);
  const available = (await registry.list()).map((capsule) => capsule.id);

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    input += chunk;
    let newline = input.indexOf('\n');
    while (newline >= 0) {
      const line = input.slice(0, newline).trim();
      input = input.slice(newline + 1);
      if (line) void handleLine(line, planner, available);
      newline = input.indexOf('\n');
    }
  });
  process.stdin.on('end', () => void app.close());
}

async function handleLine(
  line: string,
  planner: PlanFeatureUseCase,
  available: string[],
): Promise<void> {
  let message: JsonRpcRequest;
  try {
    message = JSON.parse(line) as JsonRpcRequest;
  } catch {
    writeMessage(errorResponse(null, -32700, 'Invalid JSON.'));
    return;
  }

  if (!message.method || message.id === undefined) return;

  if (message.method === 'initialize') {
    writeMessage(
      response(message.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'vibecache', version: VIBECACHE_VERSION },
      }),
    );
    return;
  }

  if (message.method === 'tools/list') {
    writeMessage(response(message.id, { tools: [TOOL, CATALOG_TOOL] }));
    return;
  }

  if (message.method !== 'tools/call') {
    writeMessage(errorResponse(message.id, -32601, 'Method not found.'));
    return;
  }

  const params = message.params ?? {};
  if (params.name === CATALOG_TOOL.name) {
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const category =
      typeof args.category === 'string' ? args.category.toLowerCase() : '';
    const search =
      typeof args.search === 'string' ? args.search.toLowerCase() : '';
    const entries = loadMarketplaceIndex().filter((entry) => {
      const categoryMatches = !category || entry.category === category;
      const searchMatches =
        !search ||
        [entry.id, entry.category, entry.publisher].some((value) =>
          value.toLowerCase().includes(search),
        );
      return categoryMatches && searchMatches;
    });
    writeMessage(
      response(message.id, {
        content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }],
      }),
    );
    return;
  }
  if (params.name !== TOOL.name) {
    writeMessage(
      errorResponse(
        message.id,
        -32602,
        `Unknown tool: ${String(params.name)}.`,
      ),
    );
    return;
  }

  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const request = typeof args.request === 'string' ? args.request.trim() : '';
  if (!request) {
    writeMessage(errorResponse(message.id, -32602, 'request is required.'));
    return;
  }
  const feature =
    typeof args.feature === 'string' && args.feature.trim()
      ? args.feature.trim()
      : inferFeature(request, available);
  if (!feature) {
    writeMessage(
      response(message.id, {
        isError: true,
        content: [
          {
            type: 'text',
            text: `No capsule matched the request. Available capsules: ${available.join(', ')}. Specify feature explicitly.`,
          },
        ],
      }),
    );
    return;
  }

  const repositoryPath =
    typeof args.repositoryPath === 'string' && args.repositoryPath.trim()
      ? args.repositoryPath.trim()
      : process.cwd();
  try {
    const plan = await planner.execute({
      featureId: feature,
      repositoryPath,
      request,
    });
    writeMessage(
      response(message.id, {
        content: [{ type: 'text', text: JSON.stringify(plan, null, 2) }],
      }),
    );
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    writeMessage(
      response(message.id, {
        isError: true,
        content: [{ type: 'text', text }],
      }),
    );
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `vibe-mcp: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
