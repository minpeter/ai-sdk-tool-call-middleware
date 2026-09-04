import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { generateToolCallId } from "../utils/id";
import {
  extractToolNames,
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import { stringifyToolInputWithSchema } from "../utils/tool-input-streaming";
import { tryRepairXmlSelfClosingRootWithBody } from "../utils/xml-root-repair";
import type { ParserOptions } from "./protocol-interface";
import { addTextOrForeignToolCalls } from "./yaml-xml-foreign-recovery";
import {
  buildSchemaPropNameSet,
  findToolCalls,
  parseYamlContent,
  safeYamlFailureCause,
  type ToolCallMatch,
} from "./yaml-xml-parsing";

function processToolCallMatch(
  text: string,
  tc: ToolCallMatch,
  currentIndex: number,
  processedElements: LanguageModelV4Content[],
  tools: LanguageModelV4FunctionTool[],
  options?: ParserOptions
): number {
  if (tc.startIndex < currentIndex) {
    return currentIndex;
  }

  addTextOrForeignToolCalls(
    text.slice(currentIndex, tc.startIndex),
    processedElements,
    tools
  );

  const result = parseYamlContent(
    tc.content,
    buildSchemaPropNameSet(tc.toolName, tools)
  );
  if (result.ok) {
    try {
      processedElements.push({
        type: "tool-call",
        toolCallId: generateToolCallId(),
        toolName: tc.toolName,
        input: stringifyToolInputWithSchema({
          toolName: tc.toolName,
          args: result.value,
          tools,
        }),
      });
    } catch (error) {
      const originalText = text.slice(tc.startIndex, tc.endIndex);
      options?.onError?.("Could not parse YAML tool call", {
        toolCall: safeToolCallMetadataText(originalText),
        toolName: tc.toolName,
        toolCallId: generateToolCallId(),
        dropReason: "malformed-tool-call-body",
        error: safeToolCallMetadataError(
          error instanceof Error ? error : new Error(String(error)),
          originalText
        ),
      });
      if (!toolCallTextHasPrototypeSensitiveKey(originalText)) {
        processedElements.push({ type: "text", text: originalText });
      }
    }
  } else {
    const originalText = text.slice(tc.startIndex, tc.endIndex);
    options?.onError?.("Could not parse YAML tool call", {
      toolCall: safeToolCallMetadataText(originalText),
      toolName: tc.toolName,
      toolCallId: generateToolCallId(),
      dropReason: "malformed-tool-call-body",
      cause: safeYamlFailureCause(result.failure, originalText),
    });
    if (!toolCallTextHasPrototypeSensitiveKey(originalText)) {
      processedElements.push({ type: "text", text: originalText });
    }
  }

  return tc.endIndex;
}

export function parseYamlXmlGeneratedText({
  text,
  tools,
  options,
}: {
  text: string;
  tools: LanguageModelV4FunctionTool[];
  options?: ParserOptions;
}): LanguageModelV4Content[] {
  const toolNames = extractToolNames(tools);
  if (toolNames.length === 0) {
    return [{ type: "text", text }];
  }

  const processedElements: LanguageModelV4Content[] = [];
  let currentIndex = 0;
  let parseText = text;

  let toolCalls = findToolCalls(parseText, toolNames);
  if (toolCalls.length === 0) {
    const repaired = tryRepairXmlSelfClosingRootWithBody(parseText, toolNames);
    if (repaired) {
      const repairedCalls = findToolCalls(repaired, toolNames);
      if (repairedCalls.length > 0) {
        parseText = repaired;
        toolCalls = repairedCalls;
      }
    }
  }

  for (const tc of toolCalls) {
    currentIndex = processToolCallMatch(
      parseText,
      tc,
      currentIndex,
      processedElements,
      tools,
      options
    );
  }

  if (currentIndex < parseText.length) {
    addTextOrForeignToolCalls(
      parseText.slice(currentIndex),
      processedElements,
      tools
    );
  }

  return processedElements;
}
