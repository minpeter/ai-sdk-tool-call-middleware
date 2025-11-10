/**
 * Heuristic Engine for XML Tool-Call Parsing
 *
 * This module provides a pluggable pipeline for applying text normalization,
 * repair, and object coercion heuristics to make XML tool-call parsing more
 * robust and configurable.
 */

export type HeuristicPhase = "pre-parse" | "fallback-reparse" | "post-parse";

/**
 * Intermediate representation of a tool call during parsing.
 * Carries context for heuristics to inspect and modify.
 */
export type IntermediateCall = {
  /** The name of the tool being called */
  toolName: string;
  /** The JSON schema for this tool's input */
  schema: unknown;
  /** The raw XML segment (inner content, without outer tags) */
  rawSegment: string;
  /** Parsed object, or null if parse failed */
  parsed: unknown | null;
  /** Any errors encountered during parsing */
  errors: unknown[];
  /** Optional metadata for heuristics to communicate */
  meta?: Record<string, unknown>;
};

/**
 * Result of applying a heuristic.
 */
export type HeuristicResult = {
  /** Updated raw XML segment (triggers reparse if provided) */
  rawSegment?: string;
  /** Updated parsed object (replaces current parsed value) */
  parsed?: unknown;
  /** Request an immediate reparse with the updated rawSegment */
  reparse?: boolean;
  /** Stop processing further heuristics in this phase */
  stop?: boolean;
  /** Non-fatal warnings from this heuristic */
  warnings?: string[];
};

/**
 * A single heuristic that can transform text or parsed objects.
 */
export type ToolCallHeuristic = {
  /** Unique identifier for this heuristic */
  id: string;
  /** Which phase this heuristic runs in */
  phase: HeuristicPhase;
  /** Determines if this heuristic should run for the given context */
  applies(ctx: IntermediateCall): boolean;
  /** Execute the heuristic transformation */
  run(ctx: IntermediateCall): HeuristicResult;
};

/**
 * Configuration for the heuristic pipeline.
 */
export type PipelineConfig = {
  /** Heuristics to run before initial parse (text normalization) */
  preParse?: ToolCallHeuristic[];
  /** Heuristics to run if initial parse fails (text repair) */
  fallbackReparse?: ToolCallHeuristic[];
  /** Heuristics to run after successful parse (object coercion) */
  postParse?: ToolCallHeuristic[];
};

/**
 * Options for the heuristic engine.
 */
export type EngineOptions = {
  /** Parser function to use (converts raw XML segment to object) */
  parse: (xml: string, schema: unknown) => unknown;
  /** Optional error callback */
  onError?: (message: string, metadata?: Record<string, unknown>) => void;
};

/**
 * Execute a phase of heuristics on the intermediate call.
 *
 * @param ctx - The current intermediate call state
 * @param heuristics - List of heuristics to apply in this phase
 * @param parse - The parser function to use for reparses
 * @returns Updated intermediate call state
 */
function executePhase(
  ctx: IntermediateCall,
  heuristics: ToolCallHeuristic[],
  parse: (xml: string, schema: unknown) => unknown
): IntermediateCall {
  let current = ctx;

  for (const heuristic of heuristics) {
    if (!heuristic.applies(current)) {
      continue;
    }

    const result = heuristic.run(current);

    // Update rawSegment if provided
    if (result.rawSegment !== undefined) {
      current = { ...current, rawSegment: result.rawSegment };
    }

    // Update parsed if provided
    if (result.parsed !== undefined) {
      current = { ...current, parsed: result.parsed };
    }

    // Merge metadata
    if (result.warnings && result.warnings.length > 0) {
      const meta = current.meta || {};
      const warnings = (meta.warnings as string[] | undefined) || [];
      current = {
        ...current,
        meta: { ...meta, warnings: [...warnings, ...result.warnings] },
      };
    }

    // Reparse if requested
    if (result.reparse && result.rawSegment !== undefined) {
      try {
        const reparsed = parse(result.rawSegment, current.schema);
        current = { ...current, parsed: reparsed, errors: [] };
      } catch (error) {
        current = {
          ...current,
          errors: [...current.errors, error],
        };
      }
    }

    // Stop if requested
    if (result.stop) {
      break;
    }
  }

  return current;
}

/**
 * Main orchestrator that applies the heuristic pipeline.
 *
 * @param ctx - Initial intermediate call state
 * @param config - Pipeline configuration
 * @param options - Engine options including parser
 * @returns Final intermediate call state after all applicable heuristics
 */
export function applyHeuristicPipeline(
  ctx: IntermediateCall,
  config: PipelineConfig,
  options: EngineOptions
): IntermediateCall {
  let current = ctx;

  // Phase 1: Pre-parse (text normalization)
  if (config.preParse && config.preParse.length > 0) {
    current = executePhase(current, config.preParse, options.parse);
  }

  // Attempt initial parse if not already done
  if (current.parsed === null && current.errors.length === 0) {
    try {
      const parsed = options.parse(current.rawSegment, current.schema);
      current = { ...current, parsed, errors: [] };
    } catch (error) {
      current = { ...current, errors: [error] };
    }
  }

  // Phase 2: Fallback-reparse (text repair if parse failed)
  if (
    current.errors.length > 0 &&
    config.fallbackReparse &&
    config.fallbackReparse.length > 0
  ) {
    current = executePhase(current, config.fallbackReparse, options.parse);
  }

  // Phase 3: Post-parse (object repair/coercion)
  if (
    current.parsed !== null &&
    config.postParse &&
    config.postParse.length > 0
  ) {
    current = executePhase(current, config.postParse, options.parse);
  }

  return current;
}
