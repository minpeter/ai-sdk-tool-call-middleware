# Repository quality gates

`pnpm quality:metrics` analyzes every TypeScript file below `src` except generated test fixtures and snapshots. Mehen enforces the repository thresholds from `mehen.toml`; the runner also prints a compact per-file list so CI always exposes every offending metric value.

The limits are strict: cyclomatic and cognitive maximums must be below 22, Halstead difficulty must be below 80, and physical LOC must be below 500. Because mehen's configured upper bounds are inclusive, the integer metrics are configured as 21 and 499, while Halstead difficulty uses the closest representable TOML value below 80.

Mehen does not publish CRAP directly. Pass an LCOV report with `pnpm quality:metrics -- --coverage coverage/lcov.info` to join mehen's per-file `cyclomatic.max` and `coverage.line` values. The runner computes `CRAP = CC^2 * (1 - coverage)^3 + CC`, reports values at or above 25, and fails the gate. Without coverage input, CRAP is explicitly reported as unavailable rather than guessed.

`quality:types` uses ast-grep's TypeScript AST and counts only `predefined_type` nodes spelled `any` or `unknown`; identifiers and prose are not counted. `quality:dead-code` runs knip without suppressions. `quality:duplicates` runs jscpd with its minimal five-line/fifty-token clone boundary and fails on the first or any additional clone.

`pnpm mutation` sorts the production TypeScript paths and distributes them round-robin across exactly 24 deterministic shards. Each shard writes `reports/mutation/shard-NN.json`. Use `pnpm mutation -- --shard N` for one shard; omit the option to run and aggregate all shards. Stryker runs in an OS temporary sandbox with type-suppression rewriting disabled; each sandbox is removed in a `finally` block, so its backup and Vitest setup files never enter the repository. The gate passes only when both survived and timeout counts are zero.
