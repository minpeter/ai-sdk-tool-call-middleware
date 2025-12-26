---
"@ai-sdk-tool/parser": minor
---

feat(parser): implement pluggable heuristic pipeline for XML parsing

- Add 3-phase heuristic engine (pre-parse, fallback-reparse, post-parse)
- Add 5 default XML heuristics: normalizeCloseTags, escapeInvalidLt, balanceTags, dedupeShellStringTags, repairAgainstSchema
- Reorganize heuristics into dedicated `src/heuristics/` module
- Export heuristic APIs for custom pipeline configuration
