import { parse } from "./core/parser";
import {
  applyHeuristicPipeline,
  createIntermediateCall,
  defaultPipelineConfig,
  type PipelineConfig,
  type ToolCallHeuristic,
} from "./heuristics";

export interface XmlFragmentParseOptions {
  heuristics?: ToolCallHeuristic[];
  pipeline?: PipelineConfig;
  maxReparses?: number;
  onError?: (message: string, metadata?: Record<string, unknown>) => void;
  /**
   * Optional context identifier passed into heuristics.
   * When omitted, heuristics will see an empty string.
   */
  contextName?: string;
  [key: string]: unknown;
}

export interface XmlFragmentParseResult {
  parsed: unknown | null;
  rawSegment: string;
  errors: unknown[];
  meta?: Record<string, unknown>;
}

function mergePipelineConfig(
  pipeline: PipelineConfig | undefined,
  heuristics: ToolCallHeuristic[] | undefined
): PipelineConfig {
  if (!heuristics || heuristics.length === 0) {
    return pipeline ?? defaultPipelineConfig;
  }

  const heuristicsConfig: PipelineConfig = {
    preParse: [],
    fallbackReparse: [],
    postParse: [],
  };

  for (const h of heuristics) {
    if (h.phase === "pre-parse") {
      heuristicsConfig.preParse?.push(h);
    } else if (h.phase === "fallback-reparse") {
      heuristicsConfig.fallbackReparse?.push(h);
    } else if (h.phase === "post-parse") {
      heuristicsConfig.postParse?.push(h);
    }
  }

  if (!pipeline) {
    return heuristicsConfig;
  }

  return {
    preParse: [
      ...(pipeline.preParse ?? []),
      ...(heuristicsConfig.preParse ?? []),
    ],
    fallbackReparse: [
      ...(pipeline.fallbackReparse ?? []),
      ...(heuristicsConfig.fallbackReparse ?? []),
    ],
    postParse: [
      ...(pipeline.postParse ?? []),
      ...(heuristicsConfig.postParse ?? []),
    ],
  };
}

export function parseXmlFragment(
  xml: string,
  schema: unknown,
  options?: XmlFragmentParseOptions
): XmlFragmentParseResult {
  const pipelineConfig = mergePipelineConfig(
    options?.pipeline,
    options?.heuristics
  );

  const ctx = createIntermediateCall(options?.contextName ?? "", xml, schema);

  const result = applyHeuristicPipeline(ctx, pipelineConfig, {
    parse: (raw, s) =>
      parse(raw, s, { onError: options?.onError, noChildNodes: [] }),
    onError: options?.onError,
    maxReparses: options?.maxReparses,
  });

  return result;
}
