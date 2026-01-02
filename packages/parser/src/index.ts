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
export * from "./core/protocols/json-protocol";
export * from "./core/protocols/protocol-interface";
export type { XmlProtocolOptions } from "./core/protocols/xml-protocol";
export { xmlProtocol } from "./core/protocols/xml-protocol";
export type { YamlProtocolOptions } from "./core/protocols/yaml-protocol";
export { yamlProtocol } from "./core/protocols/yaml-protocol";
export type { TCMToolDefinition, TCMToolInputExample } from "./core/types";

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
