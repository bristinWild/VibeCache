#!/usr/bin/env node
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { CliAppModule } from './cli-app.module';
import { createCli } from './cli/cli-program';
import { TerminalConfirmationPrompt } from './cli/terminal-confirmation';
import {
  CAPSULE_REGISTRY_PORT,
  type CapsuleRegistryPort,
} from './core/ports/capsule-registry.port';
import { RUN_STORE_PORT, type RunStorePort } from './core/ports/run-store.port';
import { ExecuteFeatureUseCase } from './core/use-cases/execute-feature.use-case';
import { InspectProjectUseCase } from './core/use-cases/inspect-project.use-case';
import { PlanFeatureUseCase } from './core/use-cases/plan-feature.use-case';

async function bootstrap(): Promise<void> {
  const executionAbort = new AbortController();
  const interrupt = () => executionAbort.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const app = await NestFactory.createApplicationContext(CliAppModule, {
    logger: false,
  });

  try {
    const cli = createCli({
      inspectProject: app.get(InspectProjectUseCase),
      planFeature: app.get(PlanFeatureUseCase),
      executeFeature: app.get(ExecuteFeatureUseCase),
      registry: app.get<CapsuleRegistryPort>(CAPSULE_REGISTRY_PORT),
      runs: app.get<RunStorePort>(RUN_STORE_PORT),
      confirmation: new TerminalConfirmationPrompt(),
      executionSignal: executionAbort.signal,
    });
    await cli.parseAsync(process.argv);
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await app.close();
  }
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`vibe: ${message}\n`);
  process.exitCode = 1;
});
