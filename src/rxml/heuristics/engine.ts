/**
 * Heuristic Engine for XML Tool-Call Parsing
 *
 * Pluggable pipeline for text normalization, repair, and object coercion.
 *
 * Phases:
 * 1. pre-parse: Text normalization before initial parse
 * 2. fallback-reparse: Text repair when initial parse fails
 * 3. post-parse: Object repair/coercion after successful parse
 */

export type HeuristicPhase = "pre-parse" | "fallback-reparse" | "post-parse";

export interface IntermediateCall {
  errors: unknown[];
  meta?: Record<string, unknown>;
  parsed: unknown | null;
  rawSegment: string;
  schema: unknown;
  toolName: string;
}

export interface HeuristicResult {
  parsed?: unknown;
  rawSegment?: string;
  reparse?: boolean;
  stop?: boolean;
  warnings?: string[];
}

export interface ToolCallHeuristic {
  applies(ctx: IntermediateCall): boolean;
  id: string;
  phase: HeuristicPhase;
  run(ctx: IntermediateCall): HeuristicResult;
}

export interface PipelineConfig {
  fallbackReparse?: ToolCallHeuristic[];
  postParse?: ToolCallHeuristic[];
  preParse?: ToolCallHeuristic[];
}

interface HeuristicEngineOptions {
  maxReparses?: number;
  onError?: (message: string, metadata?: Record<string, unknown>) => void;
  parse: (xml: string, schema: unknown) => unknown;
}

function applyRawSegmentUpdate(
  current: IntermediateCall,
  result: HeuristicResult
): IntermediateCall {
  if (result.rawSegment !== undefined) {
    return { ...current, rawSegment: result.rawSegment };
  }
  return current;
}

function applyParsedUpdate(
  current: IntermediateCall,
  result: HeuristicResult
): IntermediateCall {
  if (result.parsed !== undefined) {
    return { ...current, parsed: result.parsed };
  }
  return current;
}

function applyWarningsUpdate(
  current: IntermediateCall,
  result: HeuristicResult
): IntermediateCall {
  if (result.warnings && result.warnings.length > 0) {
    const meta = current.meta ?? {};
    const existingWarnings = (meta.warnings as string[] | undefined) ?? [];
    return {
      ...current,
      meta: { ...meta, warnings: [...existingWarnings, ...result.warnings] },
    };
  }
  return current;
}

function attemptReparse(
  current: IntermediateCall,
  result: HeuristicResult,
  reparseCount: number,
  maxReparses: number,
  parse: (xml: string, schema: unknown) => unknown
): { state: IntermediateCall; newCount: number } {
  if (
    !result.reparse ||
    result.rawSegment === undefined ||
    reparseCount >= maxReparses
  ) {
    return { state: current, newCount: reparseCount };
  }

  try {
    const reparsed = parse(result.rawSegment, current.schema);
    return {
      state: { ...current, parsed: reparsed, errors: [] },
      newCount: reparseCount + 1,
    };
  } catch (error) {
    return {
      state: { ...current, errors: [...current.errors, error] },
      newCount: reparseCount + 1,
    };
  }
}

function executePhase(
  ctx: IntermediateCall,
  heuristics: ToolCallHeuristic[],
  options: HeuristicEngineOptions
): IntermediateCall {
  let current = ctx;
  let reparseCount = 0;
  const maxReparses = options.maxReparses ?? 2;

  for (const heuristic of heuristics) {
    if (!heuristic.applies(current)) {
      continue;
    }

    const result = heuristic.run(current);

    current = applyRawSegmentUpdate(current, result);
    current = applyParsedUpdate(current, result);
    current = applyWarningsUpdate(current, result);

    const reparseResult = attemptReparse(
      current,
      result,
      reparseCount,
      maxReparses,
      options.parse
    );
    current = reparseResult.state;
    reparseCount = reparseResult.newCount;

    if (result.stop) {
      break;
    }
  }

  return current;
}

export function applyHeuristicPipeline(
  ctx: IntermediateCall,
  config: PipelineConfig,
  options: HeuristicEngineOptions
): IntermediateCall {
  let current = ctx;

  if (config.preParse && config.preParse.length > 0) {
    current = executePhase(current, config.preParse, options);
  }

  if (current.parsed === null && current.errors.length === 0) {
    try {
      const parsed = options.parse(current.rawSegment, current.schema);
      current = { ...current, parsed, errors: [] };
    } catch (error) {
      current = { ...current, errors: [error] };
    }
  }

  if (
    current.errors.length > 0 &&
    config.fallbackReparse &&
    config.fallbackReparse.length > 0
  ) {
    current = executePhase(current, config.fallbackReparse, options);
  }

  if (
    current.parsed !== null &&
    config.postParse &&
    config.postParse.length > 0
  ) {
    current = executePhase(current, config.postParse, options);
  }

  return current;
}

export function createIntermediateCall(
  toolName: string,
  rawSegment: string,
  schema: unknown
): IntermediateCall {
  return {
    toolName,
    schema,
    rawSegment,
    parsed: null,
    errors: [],
    meta: { originalContent: rawSegment },
  };
}

export function mergePipelineConfigs(
  ...configs: PipelineConfig[]
): PipelineConfig {
  const result: PipelineConfig = {
    preParse: [],
    fallbackReparse: [],
    postParse: [],
  };

  for (const config of configs) {
    if (config.preParse) {
      result.preParse = [...(result.preParse ?? []), ...config.preParse];
    }
    if (config.fallbackReparse) {
      result.fallbackReparse = [
        ...(result.fallbackReparse ?? []),
        ...config.fallbackReparse,
      ];
    }
    if (config.postParse) {
      result.postParse = [...(result.postParse ?? []), ...config.postParse];
    }
  }

  return result;
}
