// biome-ignore-all lint/performance/noBarrelFile: intentional public API surface

// Tool-response formatters, system prompt templates & media strategy
export {
  createGlm5ToolResponseFormatter,
  formatToolResponseAsGlm5,
  GLM5_CHAT_TEMPLATE_REVISION,
  GLM5_CHAT_TEMPLATE_SHA256,
  glm5SystemPromptTemplate,
  renderGlm5ToolDefinition,
} from "./core/prompts/glm5-prompt";
export {
  createHermesToolResponseFormatter,
  formatToolResponseAsHermes,
  hermesSystemPromptTemplate,
} from "./core/prompts/hermes-prompt";
export {
  createKExaone2ToolResponseFormatter,
  formatToolResponseAsKExaone2,
  kExaone2SystemPromptTemplate,
} from "./core/prompts/k-exaone-2-prompt";
export {
  kExaone236BSystemPromptMessages,
  kExaone236BToolDeclaration,
} from "./core/prompts/k-exaone-236b-prompt";
export {
  createMorphXmlToolResponseFormatter,
  morphFormatToolResponseAsXml,
  morphXmlSystemPromptTemplate,
} from "./core/prompts/morph-xml-prompt";
export {
  createQwen3CoderXmlToolResponseFormatter,
  formatToolResponseAsQwen3CoderXml,
  qwen3coderSystemPromptTemplate,
} from "./core/prompts/qwen3coder-prompt";
export type {
  ToolResponseMediaCapabilities,
  ToolResponseMediaMode,
  ToolResponseMediaStrategy,
  ToolResponseMediaType,
  ToolResponseUserContentPart,
} from "./core/prompts/shared/tool-result-normalizer";
export type { ToolResponsePromptTemplateResult } from "./core/prompts/shared/tool-result-user-content";
export {
  createUserContentToolResponseTemplate,
  toolRoleContentToUserTextMessage,
} from "./core/prompts/shared/tool-role-to-user-message";
export {
  formatToolResponseAsYaml,
  yamlXmlSystemPromptTemplate,
} from "./core/prompts/yaml-xml-prompt";

// Core Protocols
export type {
  Glm5ProtocolOptions,
  Glm5StringBoundaryNormalization,
} from "./core/protocols/glm5/call-parsing";
export { glm5Protocol } from "./core/protocols/glm5/protocol";
export * from "./core/protocols/hermes/protocol";
export { kExaone2Protocol } from "./core/protocols/k-exaone/k-exaone-2-protocol";
export { kExaone236BProtocol } from "./core/protocols/k-exaone/k-exaone-236b-protocol";
export type { MorphXmlProtocolOptions } from "./core/protocols/morph-xml/protocol";
export { morphXmlProtocol } from "./core/protocols/morph-xml/protocol";
export * from "./core/protocols/protocol-interface";
export { qwen3CoderProtocol } from "./core/protocols/qwen3coder/protocol";
export type { YamlXmlProtocolOptions } from "./core/protocols/yaml-xml/protocol";
export { yamlXmlProtocol } from "./core/protocols/yaml-xml/protocol";

// Utilities
export * from "./core/utils/diagnostics/debug";
export * from "./core/utils/diagnostics/on-error";
export * from "./core/utils/primitives/get-potential-start-index";
export * from "./core/utils/primitives/type-guards";
export * from "./core/utils/transport/dynamic-tool-schema";
export * from "./core/utils/transport/provider-options";
export { wrapGenerate } from "./generate-handler";
// Pre-configured Middleware
export * from "./preconfigured-middleware";
export * from "./rjson/index";
export { escapeRegExp } from "./shared/regex";
export { toolChoiceStream, wrapStream } from "./stream-handler";
// Tool Call Middleware Implementation
export { createToolMiddleware } from "./tool-call-middleware";
export type {
  ToolHistoryStrategy,
  ToolPromptStrategy,
  ToolSystemPromptPlacement,
} from "./transform-handler";
export {
  DEFAULT_TOOL_SYSTEM_PROMPT_PLACEMENT,
  transformParams,
} from "./transform-handler";
