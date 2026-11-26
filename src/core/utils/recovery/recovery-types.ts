import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { getSchemaType, unwrapJsonSchema } from "../../../schema-coerce";
import { coerceToolCallInput } from "../coercion/tool-call-coercion";
import { isRecord } from "./generated-text-json-candidates";

export interface ToolCallCandidate {
  input: string;
  toolName: string;
}

/** A recovered call with the span of source text it consumes. */
export interface RecoveredCallSpan {
  endIndex: number;
  payload: ToolCallCandidate;
  startIndex: number;
}

export interface DroppedSensitiveSpan {
  dropReason: "prototype-sensitive-tool-candidate";
  endIndex: number;
  startIndex: number;
}

export type RecoverySpan = DroppedSensitiveSpan | RecoveredCallSpan;

/**
 * Envelope key aliases observed live (e.g. Nemotron emits tool/parameters,
 * gpt-oss emits function/parameters). Resolved names are validated against
 * the declared tools, so aliases cannot misfire on arbitrary JSON.
 */
export const TOOL_NAME_KEYS = ["name", "tool", "function"] as const;
export const TOOL_ARGS_KEYS = ["arguments", "parameters"] as const;

export function toToolCallCandidate(
  toolName: string,
  args: unknown,
  tools: LanguageModelV4FunctionTool[]
): ToolCallCandidate | null {
  const input = coerceToolCallInput(toolName, args, tools);
  return input === undefined ? null : { toolName, input };
}

export function readToolNameField(
  payload: Record<string, unknown>
): string | null {
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

export function readToolArgsField(payload: Record<string, unknown>): unknown {
  for (const key of TOOL_ARGS_KEYS) {
    if (Object.hasOwn(payload, key)) {
      return payload[key];
    }
  }
  return {};
}

export function hasNameEnvelope(payload: Record<string, unknown>): boolean {
  return TOOL_NAME_KEYS.some(
    (key) =>
      Object.hasOwn(payload, key) &&
      typeof payload[key] === "string" &&
      (payload[key] as string).length > 0
  );
}

export function hasArgumentsEnvelope(
  payload: Record<string, unknown>
): boolean {
  return TOOL_ARGS_KEYS.some(
    (key) =>
      Object.hasOwn(payload, key) &&
      (typeof payload[key] === "string" || isRecord(payload[key]))
  );
}

export function isLikelyArgumentsShapeForTool(
  args: Record<string, unknown>,
  tool: LanguageModelV4FunctionTool
): boolean {
  const unwrapped = unwrapJsonSchema(tool.inputSchema);
  if (!isRecord(unwrapped)) {
    return false;
  }
  if (getSchemaType(unwrapped) !== "object") {
    return false;
  }

  const { properties } = unwrapped;
  if (!isRecord(properties)) {
    return false;
  }

  const keys = Object.keys(args);
  if (keys.length === 0) {
    return false;
  }

  const knownKeys = keys.filter((key) => Object.hasOwn(properties, key));
  return knownKeys.length > 0;
}
