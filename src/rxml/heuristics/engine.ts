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

import type { JSONObject } from "@ai-sdk/provider";
import type { RxmlValue } from "../builders/stringify";

type HeuristicPhase = "pre-parse" | "fallback-reparse" | "post-parse";

export interface IntermediateCall {
  errors: Error[];
  meta?: JSONObject;
  parsed: RxmlValue | null;
  rawSegment: string;
  schema: unknown;
  toolName: string;
}

export interface HeuristicResult {
  parsed?: RxmlValue;
  rawSegment?: string;
  reparse?: boolean;
  stop?: boolean;
  warnings?: string[];
}

export interface ToolCallHeuristic {
  applies: (ctx: IntermediateCall) => boolean;
  id: string;
  phase: HeuristicPhase;
  run: (ctx: IntermediateCall) => HeuristicResult;
}

export interface PipelineConfig {
  fallbackReparse?: ToolCallHeuristic[];
  postParse?: ToolCallHeuristic[];
  preParse?: ToolCallHeuristic[];
}

interface HeuristicEngineOptions {
  maxReparses?: number;
  onError?: (message: string, metadata?: JSONObject) => void;
  parse: (xml: string, schema: unknown) => unknown;
}

function applyWarningsUpdate(
  current: IntermediateCall,
  result: HeuristicResult
): IntermediateCall {
  if (result.warnings && result.warnings.length > 0) {
    const meta = current.meta ?? {};
    const existingWarnings = Array.isArray(meta.warnings)
      ? meta.warnings.filter(
          (warning): warning is string => typeof warning === "string"
        )
      : [];
    return {
      ...current,
      meta: { ...meta, warnings: [...existingWarnings, ...result.warnings] },
    };
  }
  return current;
}

interface RxmlValueFrame {
  readonly leaving: boolean;
  readonly value: unknown;
}

function isRxmlValue(value: unknown): value is RxmlValue {
  const active = new Set<object>();
  const stack: RxmlValueFrame[] = [{ leaving: false, value }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      continue;
    }
    const current = frame.value;
    if (frame.leaving) {
      if (typeof current === "object" && current !== null) {
        active.delete(current);
      }
      continue;
    }
    if (
      current === null ||
      current === undefined ||
      typeof current === "string" ||
      typeof current === "number" ||
      typeof current === "boolean"
    ) {
      continue;
    }
    if (typeof current !== "object" || active.has(current)) {
      return false;
    }
    active.add(current);
    stack.push({ leaving: true, value: current });
    for (const child of Object.values(current)) {
      stack.push({ leaving: false, value: child });
    }
  }
  return true;
}

function attemptReparse(
  current: IntermediateCall,
  result: HeuristicResult,
  reparseCount: number,
  maxReparses: number,
  parse: HeuristicEngineOptions["parse"]
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
    if (!isRxmlValue(reparsed)) {
      throw new TypeError("RXML parser returned a non-RXML value");
    }
    return {
      state: { ...current, parsed: reparsed, errors: [] },
      newCount: reparseCount + 1,
    };
  } catch (error) {
    return {
      state: {
        ...current,
        errors: [
          ...current.errors,
          error instanceof Error ? error : new Error(String(error)),
        ],
      },
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

    if (result.rawSegment !== undefined) {
      current = { ...current, rawSegment: result.rawSegment };
    }
    if (result.parsed !== undefined) {
      current = { ...current, parsed: result.parsed };
    }
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
      if (!isRxmlValue(parsed)) {
        throw new TypeError("RXML parser returned a non-RXML value");
      }
      current = { ...current, parsed, errors: [] };
    } catch (error) {
      current = {
        ...current,
        errors: [error instanceof Error ? error : new Error(String(error))],
      };
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
