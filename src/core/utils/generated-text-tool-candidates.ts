import type {
  JSONObject,
  JSONValue,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { getSchemaType, unwrapJsonSchema } from "../../schema-coerce";
import { isRecord } from "./generated-text-json-candidates";
import { coerceToolCallInput } from "./tool-call-coercion";

export interface ToolCallCandidate {
  readonly input: string;
  readonly toolName: string;
}

export interface RecoveredCallSpan {
  readonly endIndex: number;
  readonly payload: ToolCallCandidate;
  readonly startIndex: number;
}

export interface DroppedSensitiveSpan {
  readonly dropReason: "prototype-sensitive-tool-candidate";
  readonly endIndex: number;
  readonly startIndex: number;
}

export const TOOL_NAME_KEYS = ["name", "tool", "function"] as const;
const TOOL_ARGS_KEYS = ["arguments", "parameters"] as const;

export function toToolCallCandidate(
  toolName: string,
  args: JSONValue | undefined,
  tools: LanguageModelV4FunctionTool[]
): ToolCallCandidate | null {
  const input = coerceToolCallInput(toolName, args, tools);
  return input === undefined ? null : { toolName, input };
}

export function readToolNameField(payload: JSONObject): string | null {
  for (const key of TOOL_NAME_KEYS) {
    if (!Object.hasOwn(payload, key)) {
      continue;
    }
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function readToolArgsField(payload: JSONObject): JSONValue | undefined {
  for (const key of TOOL_ARGS_KEYS) {
    if (Object.hasOwn(payload, key)) {
      return payload[key];
    }
  }
  return {};
}

export function hasNameEnvelope(payload: JSONObject): boolean {
  return TOOL_NAME_KEYS.some(
    (key) =>
      Object.hasOwn(payload, key) &&
      typeof payload[key] === "string" &&
      payload[key].length > 0
  );
}

export function hasArgumentsEnvelope(payload: JSONObject): boolean {
  return TOOL_ARGS_KEYS.some(
    (key) =>
      Object.hasOwn(payload, key) &&
      (typeof payload[key] === "string" || isRecord(payload[key]))
  );
}

export function isLikelyArgumentsShapeForTool(
  args: JSONObject,
  tool: LanguageModelV4FunctionTool
): boolean {
  const unwrapped = unwrapJsonSchema(tool.inputSchema);
  if (!isRecord(unwrapped) || getSchemaType(unwrapped) !== "object") {
    return false;
  }
  const { properties } = unwrapped;
  if (!isRecord(properties)) {
    return false;
  }
  const keys = Object.keys(args);
  return keys.length > 0 && keys.some((key) => Object.hasOwn(properties, key));
}
