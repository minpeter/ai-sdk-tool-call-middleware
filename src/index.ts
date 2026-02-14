// biome-ignore-all lint/performance/noBarrelFile: intentional public API surface

// Core Protocols (Agnostic)

export * from "./core/protocols/json-protocol";
export * from "./core/protocols/protocol-interface";
export { uiTarsXmlProtocol } from "./core/protocols/ui-tars-xml-protocol";
export type { XmlProtocolOptions } from "./core/protocols/xml-protocol";
export { xmlProtocol } from "./core/protocols/xml-protocol";
export type { YamlProtocolOptions } from "./core/protocols/yaml-protocol";
export { yamlProtocol } from "./core/protocols/yaml-protocol";
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
export * from "./rjson";
export { toolChoiceStream, wrapStream } from "./stream-handler";
// Tool Call Middleware Implementation
export { createToolMiddleware } from "./tool-call-middleware";
export { transformParams } from "./transform-handler";
