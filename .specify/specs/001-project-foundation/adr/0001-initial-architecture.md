# ADR 0001 — Initial Middleware Architecture

## Status
Accepted — 2026-02-28

## Context
We need to ship a reliable parser middleware quickly while keeping room for additional protocol dialects. The repo already ships a single npm package (`@ai-sdk-tool/parser`) that exports multiple protocol implementations. Splitting into multiple packages would delay adoption and complicate releases. We also need an approachable sample showing how to wire middleware into AI SDK projects without requiring network calls.

## Decision
- Keep a **single-package layout** with a `core` folder for shared state machines and `src/{protocol}` folders for dialect-specific logic.
- Introduce a lightweight **example preset** (`createHelloToolMiddleware`) living under `src/examples` that depends only on existing protocols and proves the middleware contract.
- Standardize tooling around pnpm + Biome + Vitest; surface the CI pipeline in `.github/workflows/ci.yml` and a local helper script `scripts/dev-check.sh`.
- Route higher-level documentation through `.specify/*` specs and `docs/STATUS.md` to make architecture decisions auditable.

## Consequences
- Single package keeps publishing simple but means internal changes affect every consumer; mitigate with strong tests + semantic versioning.
- Example preset adds tiny maintenance cost but gives developers a minimal reproduction and a target for regression tests.
- Additional protocols must conform to the shared interfaces; future refactors should add new ADRs if boundaries move.
