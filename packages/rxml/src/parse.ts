import { parse as parseCore } from "./core/parser";
import type { ParseOptions } from "./core/types";
import { RXMLParseError } from "./errors/types";
import {
  applyHeuristicPipeline,
  createIntermediateCall,
  defaultPipelineConfig,
} from "./heuristics";

export function parse(
  xml: string,
  schema: unknown,
  options: ParseOptions = {}
): Record<string, unknown> {
  if (!options.repair) {
    return parseCore(xml, schema, options);
  }

  const baseOptions: ParseOptions = {
    ...options,
    repair: false,
  };

  const ctx = createIntermediateCall("", xml, schema);
  const result = applyHeuristicPipeline(ctx, defaultPipelineConfig, {
    parse: (raw, s) => parseCore(raw, s, baseOptions),
    onError: options.onError,
    maxReparses: options.maxReparses,
  });

  if (result.parsed !== null) {
    return result.parsed as Record<string, unknown>;
  }

  const error = result.errors[0];
  throw new RXMLParseError("Failed to parse XML with repair heuristics", error);
}
