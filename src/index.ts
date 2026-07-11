// biome-ignore-all lint/performance/noBarrelFile: intentional public API surface

// Core Protocols (Agnostic)

// Tool-response formatters + media strategy
export {
  createHermesToolResponseFormatter,
  formatToolResponseAsHermes,
  hermesSystemPromptTemplate,
} from "./core/prompts/hermes-prompt";
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
export * from "./core/protocols/hermes-protocol";
export type { MorphXmlProtocolOptions } from "./core/protocols/morph-xml-protocol";
export { morphXmlProtocol } from "./core/protocols/morph-xml-protocol";
export * from "./core/protocols/protocol-interface";
export {
  Qwen3CoderToolParser,
  qwen3CoderProtocol,
  uiTarsXmlProtocol,
} from "./core/protocols/qwen3coder-protocol";
export type { YamlXmlProtocolOptions } from "./core/protocols/yaml-xml-protocol";
export { yamlXmlProtocol } from "./core/protocols/yaml-xml-protocol";

// Utilities (Agnostic)
export * from "./core/utils/debug";
export * from "./core/utils/dynamic-tool-schema";
export * from "./core/utils/get-potential-start-index";
export * from "./core/utils/on-error";
export * from "./core/utils/provider-options";
export * from "./core/utils/regex";
export * from "./core/utils/type-guards";
export { wrapGenerate } from "./generate-handler";
// Pre-configured Middleware
export * from "./preconfigured-middleware";
export * from "./rjson/index";
export { toolChoiceStream, wrapStream } from "./stream-handler";
// Tool Call Middleware Implementation
export { createToolMiddleware } from "./tool-call-middleware";
export { transformParams } from "./transform-handler";
