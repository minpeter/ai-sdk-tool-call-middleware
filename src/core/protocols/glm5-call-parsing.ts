import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { parseGlm5CallBody as parseCallBody } from "./glm5-call-parser";
import { stringifyGlm5CallInput as stringifyCallInput } from "./glm5-call-serialization";
import type {
  Glm5CallSnapshot as CallSnapshot,
  ParsedGlm5Call as ParsedCall,
  Glm5ProtocolOptions as ProtocolOptions,
  NameResolution as ResolvedName,
  ResolvedGlm5ProtocolOptions as ResolvedProtocolOptions,
  Glm5StringBoundaryNormalization as StringBoundaryNormalization,
} from "./glm5-call-types";
import {
  MAX_GLM5_CALL_BODY_LENGTH as CALL_BODY_LENGTH_LIMIT,
  resolveGlm5ProtocolOptions as resolveProtocolOptions,
} from "./glm5-call-types";
import { resolveGlm5ToolName as resolveToolName } from "./glm5-name-resolution";
import { hasExplicitlyClosedGlm5TaggedBody as hasExplicitlyClosedTaggedBody } from "./glm5-tag-scanning";
import { normalizeGlm5StringValue as normalizeStringValue } from "./glm5-value-parsing";

export type Glm5StringBoundaryNormalization = StringBoundaryNormalization;
export type Glm5ProtocolOptions = ProtocolOptions;
export type ResolvedGlm5ProtocolOptions = ResolvedProtocolOptions;
export type ParsedGlm5Call = ParsedCall;
export type Glm5CallSnapshot = CallSnapshot;
export type NameResolution = ResolvedName;

export const MAX_GLM5_CALL_BODY_LENGTH = CALL_BODY_LENGTH_LIMIT;

export function resolveGlm5ProtocolOptions(
  options?: Glm5ProtocolOptions
): ResolvedGlm5ProtocolOptions {
  return resolveProtocolOptions(options);
}

export function hasExplicitlyClosedGlm5TaggedBody(body: string): boolean {
  return hasExplicitlyClosedTaggedBody(body);
}

export function resolveGlm5ToolName(
  rawName: string,
  tools: LanguageModelV4FunctionTool[],
  options: ResolvedGlm5ProtocolOptions
): NameResolution | null {
  return resolveToolName(rawName, tools, options);
}

export function normalizeGlm5StringValue(options: {
  complete: boolean;
  mode: Glm5StringBoundaryNormalization;
  value: string;
}): string {
  return normalizeStringValue(options);
}

export function parseGlm5CallBody(options: {
  body: string;
  complete: boolean;
  protocolOptions: ResolvedGlm5ProtocolOptions;
  tools: LanguageModelV4FunctionTool[];
}): Glm5CallSnapshot | null {
  return parseCallBody(options);
}

export function stringifyGlm5CallInput(
  call: Pick<ParsedGlm5Call, "args" | "toolName">,
  tools: LanguageModelV4FunctionTool[]
): string {
  return stringifyCallInput(call, tools);
}
