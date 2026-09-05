import { isJSONObject, type JSONObject } from "@ai-sdk/provider";
import {
  isSchemaDefinition,
  type ToolInputSchemaCandidate,
} from "../schema/tool-input-schema";
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
  schema: ToolInputSchemaCandidate,
  options: ParseOptions = {}
): JSONObject {
  const parsedSchema = isSchemaDefinition(schema) ? schema : undefined;

  if (!options.repair) {
    return parseCore(xml, parsedSchema, options);
  }

  const baseOptions: ParseOptions = {
    ...options,
    repair: false,
  };

  const ctx = createIntermediateCall("", xml, parsedSchema);
  const result = applyHeuristicPipeline(ctx, defaultPipelineConfig, {
    parse: (raw) => parseCore(raw, parsedSchema, baseOptions),
    onError: options.onError,
    maxReparses: options.maxReparses,
  });

  if (isJSONObject(result.parsed) && !Array.isArray(result.parsed)) {
    return result.parsed;
  }

  const [error] = result.errors;
  const normalizedError =
    error instanceof Error ? error : new Error(String(error), { cause: error });
  throw new RXMLParseError(
    "Failed to parse XML with repair heuristics",
    normalizedError
  );
}
