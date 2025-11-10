/**
 * Integration helpers for applying the heuristic pipeline to XML tool-call parsing.
 */

import { parse } from "@ai-sdk-tool/rxml";
import type {
  IntermediateCall,
  PipelineConfig,
} from "./heuristic-engine";
import { applyHeuristicPipeline } from "./heuristic-engine";
import { defaultPipelineConfig } from "./default-heuristics";

/**
 * Parse XML content using the heuristic pipeline.
 *
 * @param content - Raw XML content (inner, without outer tool tags)
 * @param toolName - Name of the tool being called
 * @param toolSchema - JSON schema for the tool's input
 * @param config - Pipeline configuration (defaults to standard heuristics)
 * @param options - Optional error callback
 * @returns Parsed object or null if parsing failed after all heuristics
 */
export function parseWithHeuristics(
  content: string,
  toolName: string,
  toolSchema: unknown,
  config?: PipelineConfig,
  options?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
): unknown | null {
  const pipelineConfig = config || defaultPipelineConfig;

  // Apply escapeInvalidLt and normalizeCloseTags BEFORE the pipeline
  // to match original behavior
  const MALFORMED_CLOSE_RE_G = /<\/\s+([A-Za-z0-9_:-]+)\s*>/g;
  const normalized = content.replace(MALFORMED_CLOSE_RE_G, "</$1>");
  const escaped = escapeInvalidLt(normalized);

  // Create initial intermediate call context
  // Store original content in meta for heuristics that need it
  const initialCtx: IntermediateCall = {
    toolName,
    schema: toolSchema,
    rawSegment: escaped,
    parsed: null,
    errors: [],
    meta: {
      originalContent: content, // Store original for safety checks
    },
  };

  // Create parser function for the engine
  const parseFunc = (xml: string, schema: unknown) => {
    return parse(xml, schema, {
      onError: options?.onError,
      noChildNodes: [],
    });
  };

  // Apply heuristic pipeline
  const result = applyHeuristicPipeline(initialCtx, pipelineConfig, {
    parse: parseFunc,
    onError: options?.onError,
  });

  // Return parsed object or null
  return result.parsed;
}

/**
 * Escape invalid '<' characters that are not part of tags.
 * This is a pre-processing step before applying heuristics.
 */
export function escapeInvalidLt(xml: string): string {
  const NAME_CHAR_RE = /[A-Za-z0-9_:-]/;
  const len = xml.length;
  let out = "";
  for (let i = 0; i < len; i += 1) {
    const ch = xml[i];
    if (ch === "<") {
      const next = i + 1 < len ? xml[i + 1] : "";
      if (
        !(
          NAME_CHAR_RE.test(next) ||
          next === "/" ||
          next === "!" ||
          next === "?"
        )
      ) {
        out += "&lt;";
        continue;
      }
    }
    out += ch;
  }
  return out;
}
