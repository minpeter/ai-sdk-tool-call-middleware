---
"@ai-sdk-tool/parser": major
---

Major refactoring of tool call protocol interface and implementation.

- Renamed ToolCallProtocol to TCMCoreProtocol with TCM prefix consistency
- Renamed isProtocolFactory to isTCMProtocolFactory
- Renamed file tool-call-protocol.ts to protocol-interface.ts
- Reorganized protocol implementations with cleaner structure
- Updated all type references and imports across the codebase
