import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { parse } from "../../../rxml";
import { generateToolCallId } from "../../utils/primitives/id";
import {
  extractToolNames,
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../../utils/primitives/protocol-utils";
import { recoverToolCallFromJsonCandidatesWithStatus } from "../../utils/recovery/generated-text-json-recovery";
import { toolCallTextHasPrototypeSensitiveKey } from "../../utils/security/prototype-sensitive-keys";
import { stringifyToolInputWithSchema } from "../../utils/streaming/tool-input-streaming";
import type { ParserOptions } from "../protocol-interface";
import { plainTextBodyFallback } from "./progress-analysis";
import { findToolCalls, findToolCallsWithFallbacks } from "./tool-call-finder";

interface ProcessToolCallParams {
  options?: ParserOptions;
  parseOptions?: Record<string, unknown>;
  processedElements: LanguageModelV4Content[];
  text: string;
  toolCall: {
    toolName: string;
    content: string;
    startIndex: number;
    endIndex: number;
  };
  tools: LanguageModelV4FunctionTool[];
}

function getToolSchema(tools: LanguageModelV4FunctionTool[], toolName: string) {
  return tools.find((t) => t.name === toolName)?.inputSchema;
}

function allowPlainTextBodyFallback(
  parseOptions?: Record<string, unknown>
): boolean {
  return parseOptions?.repair !== false;
}

function processToolCall(params: ProcessToolCallParams): void {
  const { toolCall, tools, options, text, processedElements, parseOptions } =
    params;
  const toolSchema = getToolSchema(tools, toolCall.toolName);

  const parseConfig = {
    ...(parseOptions ?? {}),
    onError:
      options?.onError ??
      (parseOptions as { onError?: ParserOptions["onError"] } | undefined)
        ?.onError,
  };

  try {
    const parsed =
      (allowPlainTextBodyFallback(parseOptions)
        ? plainTextBodyFallback(toolCall.content, toolSchema)
        : null) ?? parse(toolCall.content, toolSchema, parseConfig);
    processedElements.push({
      type: "tool-call",
      toolCallId: generateToolCallId(),
      toolName: toolCall.toolName,
      input: stringifyToolInputWithSchema({
        toolName: toolCall.toolName,
        args: parsed,
        tools,
      }),
    });
  } catch (error) {
    const originalCallText = text.slice(toolCall.startIndex, toolCall.endIndex);
    options?.onError?.(
      `Could not process XML tool call: ${toolCall.toolName}`,
      {
        toolCall: safeToolCallMetadataText(originalCallText),
        error: safeToolCallMetadataError(error, originalCallText),
        toolName: toolCall.toolName,
        toolCallId: generateToolCallId(),
        dropReason: "malformed-tool-call-body",
      }
    );
    if (toolCallTextHasPrototypeSensitiveKey(originalCallText)) {
      return;
    }
    processedElements.push({ type: "text", text: originalCallText });
  }
}

function pushGeneratedTextSegment(
  processedElements: LanguageModelV4Content[],
  text: string,
  tools: LanguageModelV4FunctionTool[]
): void {
  const recovered = recoverToolCallFromJsonCandidatesWithStatus(text, tools);
  if (
    recovered.kind === "recovered" ||
    recovered.kind === "dropped-sensitive-candidate"
  ) {
    processedElements.push(...recovered.content);
    return;
  }
  processedElements.push({ type: "text", text });
}

export function parseMorphXmlGeneratedText({
  text,
  tools,
  options,
  parseOptions,
}: {
  text: string;
  tools: LanguageModelV4FunctionTool[];
  options?: ParserOptions;
  parseOptions: Record<string, unknown>;
}): LanguageModelV4Content[] {
  const toolNames = extractToolNames(tools);
  if (toolNames.length === 0) {
    return [{ type: "text", text }];
  }

  const processedElements: LanguageModelV4Content[] = [];
  let currentIndex = 0;

  const { parseText, toolCalls } = findToolCallsWithFallbacks(text, tools);

  for (const tc of toolCalls) {
    if (tc.startIndex > currentIndex) {
      pushGeneratedTextSegment(
        processedElements,
        parseText.slice(currentIndex, tc.startIndex),
        tools
      );
    }
    processToolCall({
      toolCall: tc,
      tools,
      options,
      text: parseText,
      processedElements,
      parseOptions,
    });
    currentIndex = tc.endIndex;
  }

  if (currentIndex < parseText.length) {
    pushGeneratedTextSegment(
      processedElements,
      parseText.slice(currentIndex),
      tools
    );
  }

  return processedElements;
}

export function extractMorphXmlToolCallSegments({
  text,
  tools,
}: {
  text: string;
  tools: LanguageModelV4FunctionTool[];
}): string[] {
  const toolNames = tools.map((t) => t.name).filter(Boolean) as string[];
  if (toolNames.length === 0) {
    return [];
  }

  return findToolCalls(text, toolNames).map((tc) => tc.segment);
}
