import { Command, Option } from 'commander';
import { resolve } from 'node:path';
import type { CapsuleRegistryPort } from '../core/ports/capsule-registry.port';
import type { RunStorePort } from '../core/ports/run-store.port';
import type {
  ExecuteFeatureUseCase,
  FeatureExecutionEvent,
  FeatureExecutionResult,
} from '../core/use-cases/execute-feature.use-case';
import type { InspectProjectUseCase } from '../core/use-cases/inspect-project.use-case';
import type {
  PlanFeatureInput,
  PlanFeatureUseCase,
} from '../core/use-cases/plan-feature.use-case';
import type { ConfirmationPrompt } from './terminal-confirmation';
import { VIBECACHE_VERSION } from '../version';
import { loadMarketplaceIndex } from '../marketplace/marketplace-index';

export interface CliServices {
  inspectProject: Pick<InspectProjectUseCase, 'execute'>;
  planFeature: Pick<PlanFeatureUseCase, 'execute'>;
  executeFeature: Pick<ExecuteFeatureUseCase, 'execute'>;
  registry: Pick<CapsuleRegistryPort, 'list'>;
  runs: Pick<RunStorePort, 'list' | 'read'>;
  confirmation: ConfirmationPrompt;
  executionSignal?: AbortSignal;
}

export interface CliIo {
  out(value: string): void;
  err(value: string): void;
  setExitCode?(code: number): void;
}

const processIo: CliIo = {
  out: (value) => process.stdout.write(value),
  err: (value) => process.stderr.write(value),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export function createCli(
  services: CliServices,
  io: CliIo = processIo,
): Command {
  const program = new Command();
  program
    .name('vibe')
    .description(
      'Compile reusable feature capsules against Cliper repository memory.',
    )
    .version(VIBECACHE_VERSION)
    .configureOutput({
      writeOut: (value) => io.out(value),
      writeErr: (value) => io.err(value),
    });

  program
    .command('runs')
    .description('List feature execution runs for a repository.')
    .option('--path <path>', 'Repository path.', '.')
    .option('--json', 'Print machine-readable JSON.')
    .action(async (options: { path: string; json?: boolean }) => {
      const runs = await services.runs.list(resolve(options.path));
      if (options.json) {
        writeJson(io, runs);
        return;
      }
      if (runs.length === 0) {
        io.out('No VibeCache execution runs were found.\n');
        return;
      }
      for (const run of runs) {
        io.out(
          `${run.runId}  ${run.featureId}@${run.capsule.version}  ${run.status}\n`,
        );
      }
    });

  program
    .command('run')
    .description('Show one feature execution run.')
    .argument('<run-id>', 'VibeCache run id.')
    .option('--path <path>', 'Repository path.', '.')
    .option('--json', 'Print machine-readable JSON.')
    .action(
      async (runId: string, options: { path: string; json?: boolean }) => {
        const run = await services.runs.read(resolve(options.path), runId);
        if (!run) throw new Error(`Run "${runId}" was not found.`);
        if (options.json) {
          writeJson(io, run);
          return;
        }
        io.out(renderRun(run));
      },
    );

  program
    .command('resume')
    .description('Resume an interrupted or recoverable failed feature run.')
    .argument('<run-id>', 'VibeCache run id.')
    .option('--path <path>', 'Repository path.', '.')
    .addOption(
      new Option('--agent <agent>', 'Coding agent used for the retry.')
        .choices(['codex'])
        .makeOptionMandatory(),
    )
    .option('--yes', 'Skip the interactive execution confirmation.')
    .option('--json', 'Print machine-readable JSON.')
    .action(
      async (
        runId: string,
        options: {
          path: string;
          agent: 'codex';
          yes?: boolean;
          json?: boolean;
        },
      ) => {
        const repositoryPath = resolve(options.path);
        const run = await services.runs.read(repositoryPath, runId);
        if (!run) throw new Error(`Run "${runId}" was not found.`);
        const resumable =
          run.status === 'running' ||
          (run.status === 'failed' && run.failure?.recoverable === true);
        if (!resumable) {
          throw new Error(`Run "${runId}" is not recoverable.`);
        }

        const plan = await services.planFeature.execute({
          featureId: run.featureId,
          repositoryPath,
          answers: answersFromRun(run.choices),
        });
        if (plan.status !== 'ready') {
          if (options.json) writeJson(io, plan);
          else io.out(renderPlan(plan, false));
          throw new Error(
            `Plan status is ${plan.status}; this run cannot resume.`,
          );
        }
        if (!options.json) io.out(renderPlan(plan, false));

        const confirmed =
          options.yes ||
          (await services.confirmation.confirm(
            `Codex will resume run ${runId} at wave ${run.nextWave}. Continue?`,
          ));
        if (!confirmed) {
          io.out('Resume cancelled; no agent was started.\n');
          return;
        }

        const result = await services.executeFeature.execute(
          {
            plan,
            resumeRun: run,
            ...(services.executionSignal
              ? { signal: services.executionSignal }
              : {}),
          },
          (event) => io.err(renderExecutionEvent(event)),
        );
        if (options.json) writeJson(io, result);
        else io.out(renderExecutionResult(result));
        if (result.status === 'failed') io.setExitCode?.(1);
      },
    );

  program
    .command('list')
    .description('List locally available feature capsules.')
    .option('--json', 'Print machine-readable JSON.')
    .option('--category <category>', 'Filter by capsule category.')
    .action(async (options: { json?: boolean; category?: string }) => {
      const allCapsules = await services.registry.list();
      const capsules = options.category
        ? allCapsules.filter((capsule) => capsule.category === options.category)
        : allCapsules;
      if (options.json) {
        writeJson(io, capsules);
        return;
      }

      if (capsules.length === 0) {
        io.out('No feature capsules are installed.\n');
        return;
      }
      for (const capsule of capsules) {
        io.out(
          `${capsule.id}@${capsule.version}  [${capsule.category}]  ${capsule.name}\n`,
        );
      }
    });

  program
    .command('inspect')
    .description('Build a project fingerprint from existing Cliper memory.')
    .argument('[path]', 'Repository path.', '.')
    .option('--json', 'Print machine-readable JSON.')
    .action(async (repositoryPath: string, options: { json?: boolean }) => {
      const fingerprint = await services.inspectProject.execute(
        resolve(repositoryPath),
      );
      if (options.json) {
        writeJson(io, fingerprint);
        return;
      }

      io.out(renderFingerprint(fingerprint));
    });

  const mcp = program
    .command('mcp')
    .description('Configure VibeCache MCP integrations.');
  mcp
    .command('setup')
    .argument('[agent]', 'Agent to configure.', 'codex')
    .action((agent: string) => {
      if (agent !== 'codex') {
        throw new Error(
          `Unsupported MCP agent "${agent}". Supported agents: codex.`,
        );
      }
      io.out(
        [
          'Add this server to Codex MCP settings:',
          '',
          '[mcp_servers.vibecache]',
          'command = "vibe-mcp"',
          '',
          'Then restart Codex and ask: "Use Vibe and add a dark theme."',
          '',
        ].join('\n'),
      );
    });

  const marketplace = program
    .command('marketplace')
    .description('Browse approved community capsules.');
  marketplace
    .command('list')
    .option('--category <category>', 'Filter by category.')
    .action((options: { category?: string }) => {
      const entries = loadMarketplaceIndex().filter(
        (entry) => !options.category || entry.category === options.category,
      );
      for (const entry of entries) {
        io.out(
          `${entry.id}@${entry.version}  [${entry.category}]  approved by ${entry.publisher}\n`,
        );
      }
    });
  marketplace
    .command('search')
    .argument('<term>', 'Search capsule id, category, or publisher.')
    .action((term: string) => {
      const query = term.toLowerCase();
      const entries = loadMarketplaceIndex().filter((entry) =>
        [entry.id, entry.category, entry.publisher].some((value) =>
          value.toLowerCase().includes(query),
        ),
      );
      for (const entry of entries) {
        io.out(`${entry.id}@${entry.version}  [${entry.category}]\n`);
      }
    });

  program
    .command('add')
    .description('Plan or execute a feature capsule for a repository.')
    .argument('<feature>', 'Feature capsule id.')
    .option('--path <path>', 'Repository path.', '.')
    .option(
      '--request <request>',
      'Describe the requested change for the agent.',
    )
    .option('--dry-run', 'Generate a plan without changing repository files.')
    .addOption(
      new Option(
        '--agent <agent>',
        'Execute the plan with a coding agent (Codex is the default).',
      ).choices(['codex']),
    )
    .option('--yes', 'Skip the interactive execution confirmation.')
    .option(
      '--allow-dirty',
      'Allow execution when the Git worktree already has changes.',
    )
    .option('--json', 'Print machine-readable JSON.')
    .option(
      '--answer <key=value>',
      'Answer a capsule question. Repeat for multiple answers.',
      collectValues,
      [],
    )
    .action(
      async (
        featureId: string,
        options: {
          path: string;
          request?: string;
          dryRun?: boolean;
          agent?: 'codex';
          yes?: boolean;
          allowDirty?: boolean;
          json?: boolean;
          answer: string[];
        },
      ) => {
        if (options.dryRun && options.agent) {
          throw new Error('Choose one mode: --dry-run or agent execution.');
        }
        if (options.yes && options.dryRun) {
          throw new Error('--yes is only valid with agent execution.');
        }
        if (options.allowDirty && options.dryRun) {
          throw new Error('--allow-dirty is only valid with agent execution.');
        }

        const input: PlanFeatureInput = {
          featureId,
          repositoryPath: resolve(options.path),
          ...(options.request?.trim()
            ? { request: options.request.trim() }
            : {}),
          answers: parseAnswers(options.answer),
        };
        const plan = await services.planFeature.execute(input);

        if (options.dryRun) {
          if (options.json) {
            writeJson(io, plan);
            return;
          }
          io.out(renderPlan(plan, true));
          return;
        }

        if (plan.status !== 'ready') {
          if (options.json) writeJson(io, plan);
          else io.out(renderPlan(plan, false));
          throw new Error(
            `Plan status is ${plan.status}; execution cannot start.`,
          );
        }

        if (!options.json) io.out(renderPlan(plan, false));
        if (options.allowDirty) {
          io.err(
            'Warning: --allow-dirty makes it harder to distinguish existing edits from agent edits.\n',
          );
        }

        const confirmed =
          options.yes ||
          (await services.confirmation.confirm(
            `Codex will edit ${plan.repository.path} and VibeCache will run the verification commands shown above. Continue?`,
          ));
        if (!confirmed) {
          io.out('Execution cancelled; no agent was started.\n');
          return;
        }

        const result = await services.executeFeature.execute(
          {
            plan,
            allowDirty: options.allowDirty,
            ...(services.executionSignal
              ? { signal: services.executionSignal }
              : {}),
          },
          (event) => io.err(renderExecutionEvent(event)),
        );
        if (options.json) writeJson(io, result);
        else io.out(renderExecutionResult(result));
        if (result.status === 'failed') io.setExitCode?.(1);
      },
    );

  return program;
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseAnswers(
  values: readonly string[],
): Record<string, string | boolean> {
  const answers: Record<string, string | boolean> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(
        `Invalid answer "${value}". Use --answer question-id=value.`,
      );
    }

    const key = value.slice(0, separator);
    const raw = value.slice(separator + 1);
    if (Object.hasOwn(answers, key)) {
      throw new Error(`Question "${key}" was answered more than once.`);
    }
    answers[key] = raw === 'true' ? true : raw === 'false' ? false : raw;
  }
  return answers;
}

function answersFromRun(
  choices: Record<string, unknown>,
): Record<string, string | boolean> {
  const answers: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(choices)) {
    if (typeof value !== 'string' && typeof value !== 'boolean') {
      throw new Error(
        `Saved choice "${key}" is incompatible with the current capsule.`,
      );
    }
    answers[key] = value;
  }
  return answers;
}

function writeJson(io: CliIo, value: unknown): void {
  io.out(`${JSON.stringify(value, null, 2)}\n`);
}

function renderFingerprint(
  fingerprint: Awaited<ReturnType<InspectProjectUseCase['execute']>>,
): string {
  const dimensions = [
    ['framework', fingerprint.framework],
    ['auth', fingerprint.auth],
    ['orm', fingerprint.orm],
    ['database', fingerprint.database],
    ['deployment', fingerprint.deployment],
  ] as const;
  const lines = [`Repository: ${fingerprint.repositoryPath}`, 'Stack:'];
  for (const [name, detection] of dimensions) {
    const value =
      detection.status === 'detected'
        ? detection.value
        : detection.status === 'ambiguous'
          ? `ambiguous (${detection.candidates.join(', ')})`
          : 'unknown';
    lines.push(`  ${name}: ${value}`);
  }
  lines.push(
    `Capabilities: ${fingerprint.capabilities.map(({ id }) => id).join(', ') || 'none'}`,
  );
  return `${lines.join('\n')}\n`;
}

function renderPlan(
  plan: Awaited<ReturnType<PlanFeatureUseCase['execute']>>,
  dryRun: boolean,
): string {
  const lines = [
    `${plan.feature.name} (${plan.feature.id}@${plan.feature.version})`,
    `Repository: ${plan.repository.path}`,
    `Plan status: ${plan.status}`,
    'Execution waves:',
    ...plan.waves.map((wave, index) => `  ${index + 1}. ${wave.join(', ')}`),
  ];

  if (plan.questions.length > 0) {
    lines.push('Product choices:');
    for (const question of plan.questions) {
      if (question.source === 'unanswered') {
        const expected = question.options?.length
          ? question.options.join('|')
          : question.type === 'boolean'
            ? 'true|false'
            : 'value';
        lines.push(
          `  ${question.id}: unanswered; pass --answer ${question.id}=<${expected}>`,
        );
      } else {
        lines.push(
          `  ${question.id}: ${String(question.answer)} (${question.source})`,
        );
      }
    }
  }

  const resolved = plan.bindings.filter(
    (binding) => binding.status === 'resolved',
  );
  if (resolved.length > 0) {
    lines.push('Grounded bindings:');
    for (const binding of resolved) {
      lines.push(`  ${binding.target} -> ${binding.path}`);
    }
  }
  const unresolved = plan.bindings.filter(
    (binding) => binding.status !== 'resolved',
  );
  if (unresolved.length > 0) {
    lines.push('Binding issues:');
    for (const binding of unresolved) {
      if (binding.status === 'ambiguous') {
        lines.push(
          `  ${binding.target}: ambiguous (${binding.candidates.join(', ')})`,
        );
      } else {
        lines.push(`  ${binding.target}: unresolved`);
      }
    }
  }
  lines.push(
    `Evidence: ${plan.provenance.memoryIds.length} Cliper memory record(s)`,
  );
  if (plan.provenance.generatedAt) {
    lines.push(`Cliper memory generated: ${plan.provenance.generatedAt}`);
  }
  if (dryRun) {
    lines.push('Dry run only: no repository files were changed.');
  } else {
    const commands = [
      ...plan.tasks.flatMap((task) => task.verification),
      ...plan.acceptance,
    ];
    lines.push('Verification commands:');
    if (commands.length === 0) lines.push('  none');
    else {
      commands.forEach((check) =>
        lines.push(`  ${JSON.stringify([check.executable, ...check.args])}`),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderExecutionEvent(event: FeatureExecutionEvent): string {
  switch (event.type) {
    case 'run-started':
      return `Run ${event.runId} started (${event.totalWaves} wave(s)).\n`;
    case 'run-resumed':
      return `Run ${event.runId} resumed at wave ${event.nextWave} of ${event.totalWaves}.\n`;
    case 'wave-started':
      return `Wave ${event.wave} started: ${event.taskIds.join(', ')}\n`;
    case 'agent-finished':
      return `Wave ${event.wave} agent status: ${event.status}\n`;
    case 'verification-finished':
      return `${event.wave === 'acceptance' ? 'Acceptance' : `Wave ${event.wave}`} verification: ${event.status}\n`;
    case 'run-finished':
      return `Run ${event.runId} finished: ${event.status}\n`;
  }
}

function renderExecutionResult(result: FeatureExecutionResult): string {
  if (result.status === 'already-installed') {
    return `Already installed: ${result.receipt.featureId}@${result.receipt.capsule.version}\n`;
  }
  if (result.status === 'failed') {
    return [
      `Execution failed in run ${result.run.runId}.`,
      result.run.failure?.message ?? 'Review the saved run for details.',
      `Inspect: vibe run ${result.run.runId} --path ${result.run.repository.path}`,
      '',
    ].join('\n');
  }
  return [
    `Installed ${result.receipt.featureId}@${result.receipt.capsule.version}.`,
    `Run: ${result.run.runId}`,
    `Receipt: .vibe/features/${result.receipt.featureId}.json`,
    'Repository memory is now stale: review the changes, then run cliper sync.',
    '',
  ].join('\n');
}

function renderRun(run: Awaited<ReturnType<RunStorePort['read']>>): string {
  if (!run) return '';
  const lines = [
    `Run: ${run.runId}`,
    `Feature: ${run.featureId}@${run.capsule.version}`,
    `Status: ${run.status}`,
    `Repository: ${run.repository.path}`,
    `Completed waves: ${run.waveResults.filter(({ status }) => status === 'completed').length}`,
  ];
  if (run.failure) lines.push(`Failure: ${run.failure.message}`);
  return `${lines.join('\n')}\n`;
}
