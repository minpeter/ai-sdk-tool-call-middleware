# Implementation Plan

## Approach
1. **Document-driven**: finalize constitution + specs (complete) before touching core parser so future contributors share the same context.
2. **Scaffold baseline**: ensure repo has `.specify` docs, docs/STATUS, and minimal CI/test harness even if logic already exists.
3. **Modularize protocols**: keep existing `src/*` modules but enforce boundaries via index exports and explicit protocol descriptors.
4. **Observability hooks**: introduce optional event emitter and thread through middleware factory; default to noop logger.
5. **Testing ramp**: expand vitest coverage with fixtures per protocol plus streaming/unit tests; integrate coverage with Codecov.
6. **Continuous refinement**: run PASS 6 loops to tighten specs, add ADRs, update status logs, and resolve open questions.

## Key Activities
- Normalize directory structure: `.specify`, `docs`, `scripts`, `src`, `tests` (symlinked or reorganized from `src/__tests__`).
- Produce ADR for initial architecture + future-proofing (0001).
- Author `risks.md` summarizing top threats + mitigations.
- Add GitHub Action workflow for lint/type/test.
- Provide sample CLI or function (hello middleware) proving pipeline runs.

## Architecture Decisions Pending
- Event hook interface design (function vs EventEmitter) – track via ADR 0001.
- Logging facade – default to dependency-free structured console while allowing adapter injection.
- Schema coercion fallback – maintain best-effort parse but allow `emitRawToolCallTextOnError` for debugging.

## Local Development Workflow
1. `pnpm install` (once).
2. `pnpm build` or `pnpm build:watch` while developing.
3. `pnpm test --watch` for fast feedback.
4. `pnpm fmt` before commits.
5. `pnpm check` prior to PR.

## CI Workflow
- Trigger on `pull_request` + `push` to `main`.
- Jobs: `setup` (pnpm cache), `lint` (`pnpm check:biome`), `typecheck` (`pnpm check:types`), `test` (`pnpm test --runInBand`), `build` (tsup) + upload dist artifact, `coverage` (Codecov upload).
- Future: `release` job driven by Changesets manual approval.
