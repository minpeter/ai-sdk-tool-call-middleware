# Task Breakdown

## Task 1 — Formalize Protocol Interfaces
- **Objective**: Define/commonize `ProtocolDescriptor` and event types so every dialect reuses the same contracts.
- **Files**: `src/core/protocol.ts`, `src/tool-call-middleware.ts`, `src/preconfigured-middleware.ts`.
- **Commands**: `pnpm check:types`, `pnpm test`.
- **Checklist**:
  - [ ] Unified interfaces exported from core.
  - [ ] Existing protocols compile without circular deps.
  - [ ] Docs updated to explain customization.
- **Risks**: Type churn may break consumers; mitigate with incremental PR and beta tag.

## Task 2 — Observability Hook Implementation
- **Objective**: Introduce structured `onEvent` + `onError` hooks with typed payloads.
- **Files**: `src/tool-call-middleware.ts`, `src/core/events.ts`, `README.md` usage snippets.
- **Commands**: `pnpm build`, `pnpm test`, `pnpm check:biome`.
- **Checklist**:
  - [ ] Hooks optional with noop default.
  - [ ] Events documented + unit tested.
  - [ ] Examples show instrumentation.
- **Risks**: Logging may reduce throughput; allow opt-out and benchmark.

## Task 3 — Schema Coercion Hardening
- **Objective**: Add depth limits + detailed errors to schema coercion helpers.
- **Files**: `src/schema-coerce/**`, `src/__tests__/schema-coerce.test.ts`.
- **Commands**: `pnpm test --filter schema-coerce`.
- **Checklist**:
  - [ ] Recursive depth guard enforced.
  - [ ] Error metadata surfaces offending field.
  - [ ] Tests cover success + failure paths.
- **Risks**: Overly strict limits could break real payloads; make limits configurable.

## Task 4 — Streaming Parser Resilience Tests
- **Objective**: Build fuzz-lite + golden fixture tests for malformed input.
- **Files**: `src/__tests__/parser-resilience.test.ts`, `src/__tests__/fixtures/**`.
- **Commands**: `pnpm test --runInBand`.
- **Checklist**:
  - [ ] Fixtures for XML, YAML/XML, Qwen markup.
  - [ ] Parser emits recovery events instead of crashing.
  - [ ] Coverage up by ≥5%.
- **Risks**: Large fixtures slow CI; shard tests or mark long ones as `slow`.

## Task 5 — CI Workflow Setup
- **Objective**: Add GitHub Actions pipeline running lint/type/test/build/coverage.
- **Files**: `.github/workflows/ci.yml`.
- **Commands**: `gh workflow run ci.yml --ref <branch>` (manual validation), `pnpm check` (preflight).
- **Checklist**:
  - [ ] Node 20 runner cached pnpm store.
  - [ ] Separate jobs for lint/type/test/build.
  - [ ] Codecov upload on main + PR.
- **Risks**: Longer CI time; use matrix concurrency + caching.

## Task 6 — Developer Experience Docs
- **Objective**: Expand README + docs/ to cover system prompts, error hooks, and local workflows.
- **Files**: `README.md`, `docs/usage.md`, `docs/STATUS.md` (ongoing).
- **Commands**: `pnpm fmt:biome` on docs, `pnpm dlx markdownlint` (optional).
- **Checklist**:
  - [ ] Quick-start updated with new hooks.
  - [ ] Troubleshooting section referencing observability hooks.
  - [ ] STATUS log updated each pass.
- **Risks**: Docs drift; mitigate by linking spec sections + referencing DoD.

## Task 7 — Minimal Example CLI
- **Objective**: Provide runnable script demonstrating middleware wiring and logging events.
- **Files**: `examples/parser-core/src/hello-middleware.ts`, `package.json` scripts.
- **Commands**: `pnpm dlx tsx examples/parser-core/src/hello-middleware.ts`.
- **Checklist**:
  - [ ] Example uses mock model + prints events.
  - [ ] Documented in README + docs.
  - [ ] Example runs without network.
- **Risks**: Example may diverge from API; include tests referencing it.

## Task 8 — Release Governance
- **Objective**: Configure Changesets + version script to publish when ready.
- **Files**: `.changeset/config.json`, `.github/workflows/release.yml`.
- **Commands**: `pnpm changeset`, `pnpm ci:version`.
- **Checklist**:
  - [ ] Versioning instructions documented.
  - [ ] Release workflow gated on manual approval.
  - [ ] npm token usage documented securely.
- **Risks**: Accidental publish; require manual approval + environment checks.
