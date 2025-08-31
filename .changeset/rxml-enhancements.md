---
"@ai-sdk-tool/parser": patch
---

Morph XML protocol and utils robustness tweaks.

- Add `RXML` for safer XML extraction (raw string tags, duplicate checks) and use it in `morphXmlProtocol`.
- Replace relaxed JSON helper with `RJSON`; export `RXML`/`RJSON` from utils.
- Minor improvements to streaming parsing and XML stringify options.
