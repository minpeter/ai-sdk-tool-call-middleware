// biome-ignore lint/performance/noBarrelFile: Package entrypoint - must re-export for public API
export {
  stringify,
  stringifyNode,
  stringifyNodes,
  toContentString,
} from "./builders/stringify";
export {
  filter,
  parse,
  parseNode,
  parseWithoutSchema,
  simplify,
} from "./core/parser";
export {
  createXMLStream,
  findElementByIdStream,
  findElementsByClassStream,
  parseFromStream,
  processXMLStream,
  XMLTransformStream,
} from "./core/stream";
export { XMLTokenizer } from "./core/tokenizer";
// Types
export type { ParseOptions, RXMLNode, StringifyOptions } from "./core/types";
// Errors
export {
  RXMLCoercionError,
  RXMLDuplicateStringTagError,
  RXMLParseError,
  RXMLStreamError,
  RXMLStringifyError,
} from "./errors/types";
// Heuristics
export type {
  HeuristicEngineOptions,
  HeuristicPhase,
  HeuristicResult,
  IntermediateCall,
  PipelineConfig,
  ToolCallHeuristic,
} from "./heuristics";
export {
  applyHeuristicPipeline,
  balanceTags,
  balanceTagsHeuristic,
  createIntermediateCall,
  dedupeShellStringTagsHeuristic,
  dedupeSingleTag,
  defaultPipelineConfig,
  escapeInvalidLt,
  escapeInvalidLtHeuristic,
  getStringPropertyNames,
  mergePipelineConfigs,
  normalizeCloseTagsHeuristic,
  repairAgainstSchemaHeuristic,
  repairParsedAgainstSchema,
  shouldDeduplicateStringTags,
} from "./heuristics";
// Schema integration
export {
  coerceDomBySchema,
  domToObject,
  getPropertySchema,
  getStringTypedProperties,
  processArrayContent,
  processIndexedTuple,
} from "./schema/coercion";
export {
  countTagOccurrences,
  extractRawInner,
  findAllTopLevelRanges,
  findFirstTopLevelRange,
} from "./schema/extraction";
// Utils
export { unescapeXml } from "./utils/helpers";
// XML fragment parsing
export type {
  XmlFragmentParseOptions,
  XmlFragmentParseResult,
} from "./xml-fragment";
export { parseXmlFragment } from "./xml-fragment";

// Compatibility
export interface Options {
  textNodeName?: string;
  throwOnDuplicateStringTags?: boolean;
  onError?: (message: string, context?: Record<string, unknown>) => void;
}
