---
"@ai-sdk-tool/parser": minor
---

Add YAML+XML mixed tool call protocol (Orchestrator-style)

- New `yamlXmlProtocol` for parsing tool calls with YAML content inside XML tags
- New `orchestratorToolMiddleware` pre-configured middleware
- New `orchestratorSystemPromptTemplate` for customizable system prompts
- Supports YAML multiline syntax (`|` and `>`)
- Full streaming support with proper text/tool-call separation
- Self-closing tags and empty bodies return `{}`
