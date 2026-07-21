# Contributing a capsule

Community capsules are added through pull requests. A capsule is an instruction
manifest for a coding agent, not executable marketplace code.

## Submission checklist

1. Add `registry/<capsule-id>/capsule.yaml`.
2. Include a valid `category`, semantic version, capabilities, grounded targets,
   and verification commands.
3. Add the same id, version, and category to `marketplace/index.json` with
   `status: approved` only after maintainer review.
4. Add tests or fixtures when the capsule introduces new matching behavior.
5. Run `npm run marketplace:validate`, `npm test`, `npm run lint`, and
   `npm run build`.

Maintainers approve a capsule only after reviewing its instructions for hidden
side effects, unsafe secret handling, destructive defaults, and unverifiable
claims. Approved entries are immutable; publish a new version for changes.
