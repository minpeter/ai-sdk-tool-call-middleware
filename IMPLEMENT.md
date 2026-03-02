# IMPLEMENT (Execution Runbook)

## Source of truth
Read these first (create missing ones if needed, but prefer existing):
- .specify/memory/constitution.md
- .specify/specs/001-project-foundation/spec.md
- .specify/specs/001-project-foundation/plan.md
- .specify/specs/001-project-foundation/architecture.md
- .specify/specs/001-project-foundation/tasks.md
- .specify/specs/001-project-foundation/adr/0001-initial-architecture.md
- docs/STATUS.md

## Goal
Implement the codebase according to the spec-driven plan:
- repo structure exactly as planned
- minimal working vertical slice + tests
- runnable locally (document commands)
- CI skeleton if planned

## Milestones (repeat until stopped)
M0 Recon:
- detect stack (package.json/pyproject/go.mod/etc)
- identify commands: install, test, lint, run
- record them in docs/STATUS.md

M1 Scaffold:
- create planned folders/files
- add minimal tooling config (formatter/linter/test runner) only as needed

M2 Vertical slice:
- implement smallest end-to-end slice matching the spec
- add at least 1 test that passes

M3 Harden:
- error handling + logging as planned
- add 1–2 more tests
- update docs/STATUS.md: what’s done, how to run, what’s next

M4 Deepen (loop):
- re-read constitution/spec/plan
- find gaps/inconsistencies, tighten structure, add ADRs if needed
- keep diffs scoped, verify with commands
