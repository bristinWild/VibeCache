# VibeCache

VibeCache compiles reusable product-feature capsules against a repository's
existing Cliper memory. It is a standalone NestJS project built on top of
`cliper-memory`.

The product goal is:

```text
npm installs a library
shadcn installs a UI component
VibeCache installs a product capability
```

> **MVP status:** VibeCache is an early public release. The grounded planning,
> MCP, and Codex execution flows are experimental and should be reviewed before
> using them on production repositories.

The first capsules include `stripe-subscriptions`, `dark-theme`,
`wallet-connect-tab`, and `sdk-feature`. VibeCache can produce a
repository-specific plan and can attempt that plan wave-by-wave with a locally
authenticated Codex CLI.

## How it works

VibeCache does not scan a repository itself. Cliper creates and refreshes local
repository memory; VibeCache uses that memory to adapt a feature capsule:

```text
Cliper local memory
        |
        v
project fingerprint -> capsule compatibility -> semantic bindings
                                                |
                                                v
                                  deterministic task graph
                                                |
                                                v
                           confirm -> Codex wave -> verification
                                                |
                                                v
                                  run state + verified receipt
```

For `stripe-subscriptions`, VibeCache:

1. reads existing local Cliper memory;
2. detects the framework, auth, ORM, database, and repository capabilities;
3. checks capsule compatibility;
4. maps concepts such as `user-identity` and `database-schema` to repository
   paths;
5. surfaces product questions and records defaults or answers supplied with
   `--answer`;
6. produces ordered implementation waves and verification commands;
7. after explicit confirmation, sends one sequential wave at a time to Codex;
8. runs that wave's verification and does not advance when the agent or
   verification batch fails;
9. writes an installation receipt only after final acceptance passes.

VibeCache does not interactively answer capsule questions today. Inspect the
plan and supply a choice explicitly when needed:

```bash
vibe add stripe-subscriptions \
  --dry-run \
  --answer cancellation-behavior=immediately
```

Use `--json` to inspect all question metadata, evidence IDs, and binding states.
No slash command is required for the CLI flow.

## Codex MCP flow

For the conversational workflow, register the bundled `vibe-mcp` executable as
a local stdio MCP server in Codex. It exposes one tool, `vibe_plan`:

```text
Use Vibe and add a dark theme to this project.
```

Codex calls `vibe_plan`, receives the capsule tasks, Cliper evidence, grounded
paths, product choices, and verification commands, then performs the edits in
the active Codex session. VibeCache does not start a nested coding agent for
this MCP flow.

Build and link the local checkout before registering the server:

```bash
cd /path/to/vibecache
npm install
npm run build
npm link
```

Register the `vibe-mcp` command in Codex's MCP settings, then restart Codex so
the tool is discovered. The MCP server uses the current project directory by
default; it can also receive an explicit `repositoryPath`.

## Capsule catalog

Capsules are grouped by project category and can be listed with:

```bash
vibe list --category frontend
vibe list --category backend
vibe list --category sdk
vibe list --category cli
vibe list --category mcp
```

The initial catalog includes dark themes and wallet navigation for frontend
projects, API endpoints and billing for backend projects, public SDK features,
CLI commands, and MCP tools. Each capsule is a focused capability with its own
grounding requirements and verification steps.

Community authors submit capsules through pull requests. The repository checks
schema validity, registry/index alignment, tests, lint, and build before a
maintainer approves the entry:

```bash
npm run marketplace:validate
```

See [`marketplace/CONTRIBUTING.md`](marketplace/CONTRIBUTING.md) for the review
checklist and safety requirements.

## Prerequisites

The complete workflow uses:

- Node.js `^22.13.0` or `>=24.0.0` and npm;
- Git for the later execution workflow;
- the separate Cliper CLI (optional when VibeCache bootstraps local JSON);
- local JSON memory generated for the target repository.

VibeCache handles this setup automatically for its CLI and MCP flows. It
enables Cliper's local JSON provider before first initialization, so new users
do not need to authenticate manually. If you want to use the Cliper CLI
directly, install it separately:

```bash
npm install --global cliper-memory
```

Configure local JSON storage manually only when using the Cliper CLI directly:

```bash
cliper auth local-json
```

Initialize memory once from a repository root, then refresh it after meaningful
repository changes:

```bash
cd /path/to/my-app
cliper init

# Later, after the repository changes:
cliper sync
```

VibeCache consumes the generated `.cliper/metadata.json` and local JSON memory.
If a repository has no Cliper metadata or searchable local memory, VibeCache
automatically enables the local JSON provider and initializes memory through its
bundled `cliper-memory` SDK. It never registers the repository with a remote
service during this bootstrap.

Execution additionally requires:

- the target path to be the exact root of a Git repository;
- at least one Git commit;
- a clean worktree unless `--allow-dirty` is explicitly supplied;
- an installed and authenticated Codex CLI.

Check Codex before the first execution:

```bash
codex --version
codex login
```

## Current local-development flow

Install and link this checkout:

```bash
cd /path/to/vibecache
nvm use
npm install
npm run build
npm link
```

Then, from a separate repository that already has Cliper memory:

```bash
cd /path/to/my-app
cliper sync
vibe inspect .
vibe add stripe-subscriptions --dry-run
```

Review and resolve every compatibility issue, question, binding, task, and
verification command before considering execution.

## Published installation

Once the package is public, the intended installation will be:

```bash
npm install --global vibecache
```

This installs both the `vibe` CLI and the `vibe-mcp` MCP server command.

## Dry-run fixture

The included Next.js + Supabase + Prisma fixture is for planning tests only. Do
not use it to test `--agent codex`: it is not a standalone executable Stripe
application or an exact Git repository root, and it does not provide all of the
scripts and dependencies declared by the capsule.

Run the fixture from this VibeCache checkout:

```bash
npm run start:cli -- inspect test/fixtures/next-supabase-prisma

npm run start:cli -- add stripe-subscriptions \
  --path test/fixtures/next-supabase-prisma \
  --dry-run
```

The `inspect` command is the source of the detected stack:

```text
framework: nextjs-app-router
auth: supabase
orm: prisma
database: postgres
```

The separate `add --dry-run` command compiles these implementation waves:

```text
Plan status: ready
1. subscription-schema
2. checkout, webhook
3. verify
```

Tasks listed together in one wave are bundled into one Codex invocation. For
example, `checkout` and `webhook` are given to the same invocation; they are not
currently run by two agents in parallel.

The fixture end-to-end test uses the real `cliper-memory` retrieval path and
asserts that dry-run planning does not modify the fixture application.

## Experimental execution

Only execute against a disposable branch or repository after reviewing a dry
run:

```bash
vibe add stripe-subscriptions --dry-run
vibe add stripe-subscriptions --agent codex
```

VibeCache shows the waves, grounded paths, and verification commands before it
asks for confirmation. `--yes` skips that confirmation and should only be used
after a separate review.

Codex runs non-interactively with `workspace-write`, bounded output, a timeout,
and no shell interpolation. One fresh Codex invocation receives all tasks in the
current wave. The next wave starts only after that invocation and its complete
verification batch pass.

A repository-wide lease prevents two VibeCache executions from editing the same
worktree concurrently. If the owning local process is still alive, a second
command fails without starting an agent. A later command can conservatively
reclaim a lock whose same-host PID is no longer alive.

### Trust boundary for verification

Capsules and their verification commands are trusted code. Verification uses
argument arrays with `shell: false`, so values are not interpolated by a shell,
and VibeCache passes only a small process-bootstrap environment allowlist rather
than arbitrary inherited variables. The named executable still runs directly
on the host with the current user's permissions: it can read repository files
or user configuration, load environment files itself, access the network when
the host permits it, change files, and run package-manager lifecycle code. In
particular, an `npx` command in another capsule may download a missing package.

Review every displayed command before confirming. Do not execute an untrusted
capsule. Third-party capsule signing, command policy, and stronger verification
sandboxing are not implemented yet.

Failed changes remain in the worktree for inspection; VibeCache does not roll
them back automatically.

## Runs, receipts, and resume

Inspect execution history from the target repository:

```bash
vibe runs
vibe run <run-id>
```

An interrupted run or a recoverable failed run retains its next wave:

```bash
vibe resume <run-id> --agent codex
```

Resume requires the same Git HEAD and the same full saved capsule/binding plan,
and it re-runs verification for every previously completed wave. It deliberately
continues from the current worktree because edits from the failed wave remain
there. It does not cryptographically reject every unrelated uncommitted edit
made after the failure, so review `git diff` before resuming.

VibeCache state is written inside the target repository:

```text
.vibe/runs/<run-id>.json
.vibe/features/<feature-id>.json
.vibe/locks/execution.lock
```

Run state is local working data and `.vibe/runs/` should remain gitignored:

```gitignore
.vibe/runs/
.vibe/locks/
```

Run records can contain bounded failure summaries from agents and verification
commands. That output may contain sensitive values printed by the target
project's tooling, so inspect run files before sharing them. Receipts keep
sanitized passed-check summaries rather than raw stdout/stderr, but still record
feature choices and repository-relative bindings. Teams may choose to commit a
reviewed `.vibe/features/` receipt as installation provenance.

## CLI development commands

Run the unpublished CLI directly from source:

```bash
npm run start:cli -- list
npm run start:cli -- inspect test/fixtures/next-supabase-prisma
npm run start:cli -- add stripe-subscriptions \
  --path test/fixtures/next-supabase-prisma \
  --dry-run
```

Add `--json` for machine-readable standard output. Supply capsule choices by
repeating `--answer` when necessary:

```bash
npm run start:cli -- add stripe-subscriptions \
  --path test/fixtures/next-supabase-prisma \
  --dry-run \
  --answer cancellation-behavior=immediately \
  --json
```

After `npm run build`, `npm link` exposes the local executable as `vibe`:

```bash
npm link
vibe list
```

## Test while developing

Keep unit tests running in one terminal:

```bash
npm run test:watch
```

Run the complete verification suite before a change is considered done:

```bash
npm run test:all
npm run lint
npm run build
```

The execution end-to-end test uses a temporary Git repository, a deterministic
agent double, real child-process verification, atomic run state, and a final
receipt. It does not invoke the real Codex CLI or validate a live Stripe
integration.

## Local HTTP API

The local API is an optional integration surface for health, inspection,
marketplace browsing, and planning. The CLI does not require the server, and
The API can generate dry-run plans and execute a confirmed plan, but it does
not currently list runs or resume runs.

Start it with:

```bash
npm run start:dev
```

It binds to `127.0.0.1:3000` by default:

```bash
curl http://127.0.0.1:3000/v1/health

curl http://127.0.0.1:3000/v1/capsules

curl http://127.0.0.1:3000/v1/capsules/dark-theme

curl -X POST http://127.0.0.1:3000/v1/projects/inspect \
  -H 'content-type: application/json' \
  -d '{"path":"/absolute/path/to/my-app"}'

curl -X POST http://127.0.0.1:3000/v1/capsules/stripe-subscriptions/plan \
  -H 'content-type: application/json' \
  -d '{"path":"/absolute/path/to/my-app"}'

curl -X POST http://127.0.0.1:3000/v1/capsules/stripe-subscriptions/execute \
  -H 'content-type: application/json' \
  -d '{"path":"/absolute/path/to/my-app","allowDirty":false}'
```

## Project structure

The core is independent of transport:

- `src/core`: domain schema, matching, binding, graph compilation, use cases
- `src/adapters/cliper`: the `cliper-memory` integration
- `src/adapters/registry`: safe YAML capsule loading
- `src/adapters/agents`: constrained Codex non-interactive execution
- `src/adapters/git`: Git preflight and drift checks
- `src/adapters/integrity`: direct protected-path content snapshots
- `src/adapters/leases`: repository-wide execution ownership
- `src/adapters/runs`: atomic, resumable execution state
- `src/adapters/verification`: bounded, non-shell command execution
- `src/adapters/receipts`: atomic verified-feature receipts
- `src/cli`: the `vibe` command
- `src/http`: local planning API controllers
- `registry`: versioned feature capsules

## Current boundaries

- Real Codex execution of the Stripe capsule is experimental and has not been
  validated end to end against a working Stripe application.
- The Stripe capsule currently supplies an implementation contract to the
  coding agent; it is not a deterministic source-code template or production
  Stripe setup wizard.
- Codex is the only execution adapter.
- Tasks within a wave use one Codex invocation rather than parallel agents.
- Verification commands are trusted host processes, not sandboxed plugins.
- Failed changes remain in the worktree; automatic rollback is not implemented.
- Capsule upgrades are rejected instead of applied automatically.
- VibeCache does not run `cliper sync` after installation.
- Broader framework support, stronger worktree-drift detection, command policy,
  sandboxed verification, and signed third-party capsule distribution are
  future milestones.
