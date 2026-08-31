import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { parse as parseRJSON } from "../../rjson";
import { hasPrototypeSensitiveStructuralKey } from "../utils/prototype-sensitive-keys";
import { toolCallInputHasSchemaAwarePrototypeSensitiveValue } from "../utils/tool-call-coercion";
import { getToolInputPropertySchema } from "../utils/tool-call-object-schema";
import type {
  Glm5CallSnapshot,
  ResolvedGlm5ProtocolOptions,
} from "./glm5-call-types";
import { resolveGlm5ToolName } from "./glm5-name-resolution";
import { safeAssignGlm5Arg } from "./glm5-value-parsing";

const STRICT_JSON_OPTIONS = {
  duplicate: false,
  relaxed: false,
  tolerant: false,
} as const;

function parseJsonFallback(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    return null;
  }
  try {
    const parsed = parseRJSON(trimmed, STRICT_JSON_OPTIONS);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      hasPrototypeSensitiveStructuralKey(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseJsonGlm5CallBody(options: {
  body: string;
  protocolOptions: ResolvedGlm5ProtocolOptions;
  tools: LanguageModelV4FunctionTool[];
}): Glm5CallSnapshot | null {
  const parsed = parseJsonFallback(options.body);
  if (!parsed) {
    return null;
  }
  const rawName = parsed.name ?? parsed.toolName;
  if (typeof rawName !== "string") {
    return null;
  }
  const resolvedName = resolveGlm5ToolName(
    rawName,
    options.tools,
    options.protocolOptions
  );
  if (!resolvedName) {
    return null;
  }
  const rawArgs = parsed.arguments ?? parsed.input ?? {};
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return null;
  }
  const schema = options.tools.find(
    (tool) => tool.name === resolvedName.value
  )?.inputSchema;
  if (toolCallInputHasSchemaAwarePrototypeSensitiveValue(rawArgs, schema)) {
    return null;
  }
  return {
    args: rawArgs as Record<string, unknown>,
    hasPartialValue: false,
    rawToolName: rawName,
    recoveries: [
      "recovered-json-call-body",
      ...(resolvedName.recovered ? ["recovered-tool-name"] : []),
    ],
    toolName: resolvedName.value,
  };
}

export function appendJsonFallbackGlm5Args(options: {
  args: Record<string, unknown>;
  body: string;
  from: number;
  recoveries: string[];
  schema: unknown;
}): "appended" | "none" | "rejected" {
  const parsed = parseJsonFallback(options.body.slice(options.from));
  if (!parsed) {
    return "none";
  }
  for (const [key, value] of Object.entries(parsed)) {
    const propertySchema = getToolInputPropertySchema(
      options.schema,
      key,
      options.args
    );
    if (
      toolCallInputHasSchemaAwarePrototypeSensitiveValue(value, propertySchema)
    ) {
      return "rejected";
    }
    if (!safeAssignGlm5Arg(options.args, key, value, options.recoveries)) {
      return "rejected";
    }
  }
  options.recoveries.push("recovered-json-arguments-body");
  return "appended";
}
