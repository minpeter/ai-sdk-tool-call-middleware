---
"@ai-sdk-tool/parser": patch
---

Improve middleware robustness and compatibility with the latest AI SDK v6 patch releases.

- Harden toolChoice JSON payload parsing with strict object validation and safe fallbacks.
- Normalize tool-call argument coercion across both generate and stream paths.
- Ensure stream protocol consistency by emitting `text-end` before `finish` when buffered text remains.
- Safely decode persisted tool schemas from provider options and recover on malformed schema payloads.
- Upgrade AI SDK-related dependencies to the latest patch versions.
