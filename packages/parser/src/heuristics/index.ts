export type {
  HeuristicEngineOptions,
  HeuristicPhase,
  HeuristicResult,
  IntermediateCall,
  PipelineConfig,
  ToolCallHeuristic,
} from "./engine";

// biome-ignore lint/performance/noBarrelFile: Module entrypoint
export {
  applyHeuristicPipeline,
  createIntermediateCall,
  mergePipelineConfigs,
} from "./engine";

export {
  balanceTags,
  balanceTagsHeuristic,
  dedupeShellStringTagsHeuristic,
  dedupeSingleTag,
  defaultPipelineConfig,
  escapeInvalidLt,
  escapeInvalidLtHeuristic,
  getStringPropertyNames,
  normalizeCloseTagsHeuristic,
  repairAgainstSchemaHeuristic,
  repairParsedAgainstSchema,
  shouldDeduplicateStringTags,
} from "./xml-defaults";
