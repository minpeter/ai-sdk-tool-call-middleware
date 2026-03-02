# Risk Register

| # | Risk | Impact | Likelihood | Mitigation |
|---|------|--------|------------|------------|
| R1 | Protocol drift between AI SDK versions and parser expectations | High | Medium | Track upstream releases monthly, add compatibility tests, gate releases via Changesets. |
| R2 | Streaming parsers fail on malformed markup leading to dropped tool calls | High | Medium | Implement resilience tests + fallback text emission, expose `emitRawToolCallTextOnError`. |
| R3 | Observability hooks add overhead and slow throughput | Medium | Medium | Keep hooks optional/noop by default, benchmark before enabling in production. |
| R4 | Schema coercion recursion can exhaust memory | High | Low | Enforce configurable depth limit + timeouts, fuzz test nested payloads. |
| R5 | CI duration inflates due to multiple jobs | Medium | Medium | Cache pnpm store, parallelize lint/type/test, fail fast with concurrency groups. |
| R6 | Lack of docs causes misconfiguration of middleware templates | Medium | Medium | Maintain docs/STATUS cadence, add usage docs referencing hello middleware example. |
| R7 | Release automation accidentally publishes unstable builds | Medium | Low | Require manual approval in release workflow and document release checklist. |
| R8 | Example + docs drift from feature behavior | Medium | Medium | Tie hello middleware test to exported behavior and add docs review gate per PR. |
| R9 | Local environments missing pnpm/node versions block contributors | Medium | Medium | Document `corepack` bootstrap + provide fallback npm scripts in docs/STATUS + README. |
| R10 | Observability hooks never implemented leading to diagnosability gaps | High | Low | Track as explicit task, guard with TODO, and add acceptance criteria in plan/spec. |
