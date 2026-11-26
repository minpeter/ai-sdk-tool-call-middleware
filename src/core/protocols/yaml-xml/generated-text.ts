import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { generateToolCallId } from "../../utils/primitives/id";
import {
  extractToolNames,
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../../utils/primitives/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../../utils/security/prototype-sensitive-keys";
import { stringifyToolInputWithSchema } from "../../utils/streaming/tool-input-streaming";
import { tryRepairXmlSelfClosingRootWithBody } from "../../utils/xml/xml-root-repair";
import type { ParserOptions } from "../protocol-interface";
import { addTextOrForeignToolCalls } from "./foreign-recovery";
import {
  buildSchemaPropNameSet,
  parseYamlContent,
  safeYamlFailureCause,
} from "./parsing";
import { findToolCalls, type ToolCallMatch } from "./tag-finding";

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
        error: safeToolCallMetadataError(error, originalText),
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

export function extractYamlXmlToolCallSegments({
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

  return findToolCalls(text, toolNames).map(
    (tc) => `<${tc.toolName}>${tc.content}</${tc.toolName}>`
  );
}
