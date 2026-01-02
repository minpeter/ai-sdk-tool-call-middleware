// biome-ignore-all lint/performance/noBarrelFile: intentional public API surface

// Core Protocols & Heuristics (Agnostic)

export type {
  HeuristicEngineOptions,
  HeuristicPhase,
  HeuristicResult,
  IntermediateCall,
  PipelineConfig,
  ToolCallHeuristic,
} from "./core/heuristics";
export {
  applyHeuristicPipeline,
  balanceTagsHeuristic,
  createIntermediateCall,
  dedupeShellStringTagsHeuristic,
  defaultPipelineConfig,
  escapeInvalidLtHeuristic,
  mergePipelineConfigs,
  normalizeCloseTagsHeuristic,
  repairAgainstSchemaHeuristic,
} from "./core/heuristics";
export * from "./core/protocols/json-mix-protocol";
export type { MorphXmlProtocolOptions } from "./core/protocols/morph-xml-protocol";
export { morphXmlProtocol } from "./core/protocols/morph-xml-protocol";
export * from "./core/protocols/tool-call-protocol";
export type { YamlXmlProtocolOptions } from "./core/protocols/yaml-xml-protocol";
export {
  orchestratorSystemPromptTemplate,
  yamlXmlProtocol,
} from "./core/protocols/yaml-xml-protocol";

// Utilities (Agnostic)
export * from "./core/utils/debug";
export * from "./core/utils/dynamic-tool-schema";
export * from "./core/utils/get-potential-start-index";
export * from "./core/utils/on-error";
export * from "./core/utils/provider-options";
export * from "./core/utils/regex";
export * from "./core/utils/robust-json";
export * from "./core/utils/type-guards";

// Default implementation is V6 (LanguageModelV3)
export * from "./v6/index";
