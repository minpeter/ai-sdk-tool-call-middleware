import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { getToolInputPropertyNames } from "../utils/tool-call-object-schema";
import type {
  Glm5CallSnapshot,
  ResolvedGlm5ProtocolOptions,
} from "./glm5-call-types";
import { MAX_GLM5_CALL_BODY_LENGTH } from "./glm5-call-types";
import { hasNestedDeclaredGlm5ToolCall } from "./glm5-call-validation";
import {
  appendJsonFallbackGlm5Args,
  parseJsonGlm5CallBody,
} from "./glm5-json-call-recovery";
import { resolveGlm5ToolName } from "./glm5-name-resolution";
import {
  extractRawGlm5ToolName,
  scanGlm5StructuralTags,
} from "./glm5-tag-scanning";
import { parseGlm5TaggedArguments } from "./glm5-tagged-arguments";
import { createGlm5Args } from "./glm5-value-parsing";

interface Glm5CallBodyOptions {
  body: string;
  complete: boolean;
  protocolOptions: ResolvedGlm5ProtocolOptions;
  tools: LanguageModelV4FunctionTool[];
}

interface StrayArgValueCloseCandidate {
  readonly argsStart: number;
  readonly body: string;
  readonly complete: boolean;
  readonly declaredArgumentNames: ReadonlySet<string> | null;
  readonly tags: NonNullable<ReturnType<typeof scanGlm5StructuralTags>>;
}

function isRejectedGlm5Call(options: Glm5CallBodyOptions): boolean {
  return (
    options.body.length > MAX_GLM5_CALL_BODY_LENGTH ||
    hasNestedDeclaredGlm5ToolCall(options)
  );
}

function isStrayEmptyArgValueClose({
  argsStart,
  body,
  complete,
  declaredArgumentNames,
  tags,
}: StrayArgValueCloseCandidate): boolean {
  const [onlyTag] = tags;
  return (
    complete &&
    tags.length === 1 &&
    onlyTag?.name === "arg_value" &&
    onlyTag.closing &&
    declaredArgumentNames?.size === 0 &&
    body.slice(argsStart, onlyTag.start).trim().length === 0 &&
    body.slice(onlyTag.end).trim().length === 0
  );
}

export function parseGlm5CallBody(options: {
  body: string;
  complete: boolean;
  protocolOptions: ResolvedGlm5ProtocolOptions;
  tools: LanguageModelV4FunctionTool[];
}): Glm5CallSnapshot | null {
  if (isRejectedGlm5Call(options)) {
    return null;
  }
  if (options.complete) {
    const jsonCall = parseJsonGlm5CallBody(options);
    if (jsonCall) {
      return jsonCall;
    }
  }

  const tags = scanGlm5StructuralTags(options.body);
  if (!tags) {
    return null;
  }
  const extractedName = extractRawGlm5ToolName({
    body: options.body,
    complete: options.complete,
    tags,
  });
  if (!extractedName) {
    return null;
  }
  const resolvedName = resolveGlm5ToolName(
    extractedName.rawName,
    options.tools,
    options.protocolOptions
  );
  if (!resolvedName) {
    return null;
  }

  const tool = options.tools.find(
    (candidate) => candidate.name === resolvedName.value
  );
  const schema = tool?.inputSchema;
  const args = createGlm5Args();
  const recoveries = resolvedName.recovered ? ["recovered-tool-name"] : [];
  const parsedArguments = parseGlm5TaggedArguments({
    args,
    argsStart: extractedName.argsStart,
    body: options.body,
    complete: options.complete,
    protocolOptions: options.protocolOptions,
    recoveries,
    schema,
    tags,
  });
  if (!parsedArguments) {
    return null;
  }
  const { hasPartialValue } = parsedArguments;
  let { consumedUntil } = parsedArguments;

  const declaredArgumentNames = getToolInputPropertyNames(schema, args);
  if (
    isStrayEmptyArgValueClose({
      argsStart: extractedName.argsStart,
      body: options.body,
      complete: options.complete,
      declaredArgumentNames,
      tags,
    })
  ) {
    consumedUntil = options.body.length;
    recoveries.push("recovered-stray-empty-arg-value-close");
  }

  if (tags.length === 0 && options.complete) {
    const fallbackResult = appendJsonFallbackGlm5Args({
      args,
      body: options.body,
      from: extractedName.argsStart,
      recoveries,
      schema,
    });
    if (fallbackResult === "rejected") {
      return null;
    }
    if (
      fallbackResult === "none" &&
      options.body.slice(extractedName.argsStart).trim().length > 0
    ) {
      return null;
    }
    consumedUntil = options.body.length;
  }

  if (options.complete && options.body.slice(consumedUntil).trim().length > 0) {
    return null;
  }

  return {
    args,
    hasPartialValue,
    rawToolName: extractedName.rawName,
    recoveries: Array.from(new Set(recoveries)),
    toolName: resolvedName.value,
  };
}
