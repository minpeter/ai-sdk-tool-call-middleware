import type {
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import {
  extractRawInner,
  findFirstTopLevelRange,
  parse,
  RXMLCoercionError,
  RXMLDuplicateStringTagError,
  RXMLParseError,
  stringify,
  unwrapJsonSchema,
} from "@ai-sdk-tool/rxml";

import { hasInputProperty } from "@/utils";

import type { ToolCallProtocol } from "./tool-call-protocol";

// Regex constants for performance
const WHITESPACE_REGEX = /\s/;

// Helper functions to reduce cognitive complexity

function processTextBeforeToolCall(
  text: string,
  currentIndex: number,
  toolCallStartIndex: number,
  processedElements: LanguageModelV2Content[]
): number {
  if (toolCallStartIndex > currentIndex) {
    const textSegment = text.substring(currentIndex, toolCallStartIndex);
    if (textSegment.trim()) {
      processedElements.push({ type: "text", text: textSegment });
    }
  }
  return currentIndex;
}

type ToolCallInfo = {
  toolName: string;
  content: string;
  startIndex: number;
  endIndex: number;
};

type ProcessToolCallParams = {
  toolCall: ToolCallInfo;
  tools: LanguageModelV2FunctionTool[];
  options: { onError?: (message: string, details?: unknown) => void } | undefined;
  text: string;
  processedElements: LanguageModelV2Content[];
};

function processToolCall(params: ProcessToolCallParams): void {
  const { toolCall, tools, options, text, processedElements } = params;
  try {
    const toolSchema = getToolSchema(tools, toolCall.toolName);
    const parsed: unknown = parse(toolCall.content, toolSchema, {
      onError: options?.onError,
      // Disable HTML self-closing tag behavior to allow base, meta, link etc. as regular tags
      noChildNodes: [],
    });

    processedElements.push({
      type: "tool-call",
      toolCallId: generateId(),
      toolName: toolCall.toolName,
      input: JSON.stringify(parsed),
    });
  } catch (error) {
    const originalCallText = text.substring(
      toolCall.startIndex,
      toolCall.endIndex
    );
    const message = `Could not process XML tool call, keeping original text: ${originalCallText}`;
    options?.onError?.(message, {
      toolCall: originalCallText,
      toolName: toolCall.toolName,
      error,
    });
    processedElements.push({ type: "text", text: originalCallText });
  }
}

function addRemainingText(
  text: string,
  currentIndex: number,
  processedElements: LanguageModelV2Content[]
): void {
  if (currentIndex < text.length) {
    const remainingText = text.substring(currentIndex);
    if (remainingText.trim()) {
      processedElements.push({ type: "text", text: remainingText });
    }
  }
}

type StreamingToolCallEndParams = {
  toolContent: string;
  currentToolCall: { name: string; content: string };
  tools: LanguageModelV2FunctionTool[];
  options: { onError?: (message: string, details?: unknown) => void } | undefined;
  ctrl: TransformStreamDefaultController;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
};

function handleStreamingToolCallEnd(params: StreamingToolCallEndParams): void {
  const { toolContent, currentToolCall, tools, options, ctrl, flushText } = params;
  try {
    const toolSchema = getToolSchema(tools, currentToolCall.name);
    const parsed: unknown = parse(toolContent, toolSchema, {
      onError: options?.onError,
      noChildNodes: [],
    });

    flushText(ctrl);
    ctrl.enqueue({
      type: "tool-call",
      toolCallId: generateId(),
      toolName: currentToolCall.name,
      input: JSON.stringify(parsed),
    });
  } catch (error) {
    handleStreamingToolCallError({
      error,
      currentToolCall,
      toolContent,
      options,
      ctrl,
      flushText,
    });
  }
}

type StreamingToolCallErrorParams = {
  error: unknown;
  currentToolCall: { name: string; content: string };
  toolContent: string;
  options: { onError?: (message: string, details?: unknown) => void } | undefined;
  ctrl: TransformStreamDefaultController;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
};

function handleStreamingToolCallError(params: StreamingToolCallErrorParams): void {
  const { error, currentToolCall, toolContent, options, ctrl, flushText } = params;
  const endTag = `</${currentToolCall.name}>`;
  const originalCallText = `<${currentToolCall.name}>${toolContent}${endTag}`;
  let message =
    "Could not process streaming XML tool call; emitting original text.";

  if (error instanceof RXMLDuplicateStringTagError) {
    message = `Duplicate string tags detected in streaming tool call '${currentToolCall.name}'; emitting original text.`;
  } else if (error instanceof RXMLCoercionError) {
    message = `Failed to coerce arguments for streaming tool call '${currentToolCall.name}'; emitting original text.`;
  } else if (error instanceof RXMLParseError) {
    message = `Failed to parse XML for streaming tool call '${currentToolCall.name}'; emitting original text.`;
  }

  options?.onError?.(message, {
    toolCall: originalCallText,
    toolName: currentToolCall.name,
    error,
  });
  flushText(ctrl, originalCallText);
}

function findEarliestToolTag(
  buffer: string,
  toolNames: string[]
): { index: number; name: string } {
  let earliestStartTagIndex = -1;
  let earliestToolName = "";

  if (toolNames.length > 0) {
    for (const name of toolNames) {
      const startTag = `<${name}>`;
      const index = buffer.indexOf(startTag);
      if (
        index !== -1 &&
        (earliestStartTagIndex === -1 || index < earliestStartTagIndex)
      ) {
        earliestStartTagIndex = index;
        earliestToolName = name;
      }
    }
  }

  return { index: earliestStartTagIndex, name: earliestToolName };
}

function handleNoToolTagInBuffer(
  buffer: string,
  maxStartTagLen: number,
  controller: TransformStreamDefaultController,
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void
): { buffer: string; shouldContinue: boolean } {
  const tail = Math.max(0, maxStartTagLen - 1);
  const safeLen = Math.max(0, buffer.length - tail);
  if (safeLen > 0) {
    const textToFlush = buffer.slice(0, safeLen);
    flushText(controller, textToFlush);
    return { buffer: buffer.slice(safeLen), shouldContinue: true };
  }
  return { buffer, shouldContinue: false };
}

type ProcessToolCallInBufferParams = {
  buffer: string;
  currentToolCall: { name: string; content: string };
  tools: LanguageModelV2FunctionTool[];
  options: { onError?: (message: string, details?: unknown) => void } | undefined;
  controller: TransformStreamDefaultController;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
};

function processToolCallInBuffer(
  params: ProcessToolCallInBufferParams
): {
  buffer: string;
  currentToolCall: { name: string; content: string } | null;
  shouldBreak: boolean;
} {
  const { buffer, currentToolCall, tools, options, controller, flushText } = params;
  const endTag = `</${currentToolCall.name}>`;
  const endTagIndex = buffer.indexOf(endTag);

  if (endTagIndex !== -1) {
    const toolContent = buffer.substring(0, endTagIndex);
    const newBuffer = buffer.substring(endTagIndex + endTag.length);

    handleStreamingToolCallEnd({
      toolContent,
      currentToolCall,
      tools,
      options,
      ctrl: controller,
      flushText,
    });
    return { buffer: newBuffer, currentToolCall: null, shouldBreak: false };
  }
  return { buffer, currentToolCall, shouldBreak: true };
}

type ProcessNoToolCallInBufferParams = {
  buffer: string;
  toolNames: string[];
  maxStartTagLen: number;
  controller: TransformStreamDefaultController;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
};

function processNoToolCallInBuffer(
  params: ProcessNoToolCallInBufferParams
): {
  buffer: string;
  currentToolCall: { name: string; content: string } | null;
  shouldBreak: boolean;
  shouldContinue: boolean;
} {
  const { buffer, toolNames, maxStartTagLen, controller, flushText } = params;
  const { index: earliestStartTagIndex, name: earliestToolName } =
    findEarliestToolTag(buffer, toolNames);

  if (earliestStartTagIndex !== -1) {
    const textBeforeTag = buffer.substring(0, earliestStartTagIndex);
    flushText(controller, textBeforeTag);

    const startTag = `<${earliestToolName}>`;
    const newBuffer = buffer.substring(earliestStartTagIndex + startTag.length);
    return {
      buffer: newBuffer,
      currentToolCall: { name: earliestToolName, content: "" },
      shouldBreak: false,
      shouldContinue: false,
    };
  }

  const result = handleNoToolTagInBuffer(
    buffer,
    maxStartTagLen,
    controller,
    flushText
  );
  return {
    buffer: result.buffer,
    currentToolCall: null,
    shouldBreak: !result.shouldContinue,
    shouldContinue: result.shouldContinue,
  };
}

export const morphXmlProtocol = (): ToolCallProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    const toolsForPrompt = (tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: unwrapJsonSchema(tool.inputSchema),
    }));
    return toolSystemPromptTemplate(JSON.stringify(toolsForPrompt));
  },

  formatToolCall(toolCall: LanguageModelV2ToolCall): string {
    let args: unknown = {};
    const inputValue = hasInputProperty(toolCall) ? toolCall.input : undefined;

    if (typeof inputValue === "string") {
      try {
        args = JSON.parse(inputValue);
      } catch {
        args = inputValue;
      }
    } else {
      args = inputValue;
    }
    return stringify(toolCall.toolName, args, {
      suppressEmptyNode: false,
      format: false,
    });
  },

  formatToolResponse(toolResult: LanguageModelV2ToolResultPart): string {
    return stringify("tool_response", {
      tool_name: toolResult.toolName,
      result: toolResult.output,
    });
  },

  parseGeneratedText({ text, tools, options }) {
    const toolNames = tools.map((t) => t.name).filter((name) => name != null);
    if (toolNames.length === 0) {
      return [{ type: "text", text }];
    }

    const processedElements: LanguageModelV2Content[] = [];
    let currentIndex = 0;

    // Find all tool calls using proper XML parsing
    const toolCalls = findToolCalls(text, toolNames);

    // Process text and tool calls in order
    for (const toolCall of toolCalls) {
      // Add text before this tool call
      currentIndex = processTextBeforeToolCall(
        text,
        currentIndex,
        toolCall.startIndex,
        processedElements
      );

      // Process the tool call
      processToolCall({ toolCall, tools, options, text, processedElements });

      currentIndex = toolCall.endIndex;
    }

    // Add remaining text
    addRemainingText(text, currentIndex, processedElements);

    return processedElements;
  },

  createStreamParser({ tools, options }) {
    const toolNames = tools.map((t) => t.name).filter((name) => name != null);
    const maxStartTagLen = toolNames.length
      ? Math.max(...toolNames.map((n) => `<${n}>`.length))
      : 0;
    let buffer = "";
    let currentToolCall: { name: string; content: string } | null = null;
    let currentTextId: string | null = null;

    const flushText = (
      controller: TransformStreamDefaultController,
      text?: string
    ) => {
      const content = text ?? buffer;
      if (content) {
        if (!currentTextId) {
          currentTextId = generateId();
          controller.enqueue({ type: "text-start", id: currentTextId });
        }
        controller.enqueue({
          type: "text-delta",
          id: currentTextId,
          delta: content,
        });
        if (text === undefined) {
          buffer = "";
        }
      }

      if (currentTextId && !text) {
        controller.enqueue({ type: "text-end", id: currentTextId });
        currentTextId = null;
      }
    };

    const processChunk = (
      chunk: { type: string; delta?: string },
      controller: TransformStreamDefaultController
    ) => {
      if (chunk.type !== "text-delta") {
        if (buffer) {
          flushText(controller);
        }
        controller.enqueue(chunk);
        return;
      }

      buffer += chunk.delta;
      processBuffer(controller);
    };

    const processBuffer = (controller: TransformStreamDefaultController) => {
      while (true) {
        if (currentToolCall) {
          const result = processToolCallInBuffer({
            buffer,
            currentToolCall,
            tools,
            options,
            controller,
            flushText,
          });
          buffer = result.buffer;
          currentToolCall = result.currentToolCall;
          if (result.shouldBreak) {
            break;
          }
        } else {
          const result = processNoToolCallInBuffer({
            buffer,
            toolNames,
            maxStartTagLen,
            controller,
            flushText,
          });
          buffer = result.buffer;
          currentToolCall = result.currentToolCall;
          if (result.shouldContinue) {
            continue;
          }
          if (result.shouldBreak) {
            break;
          }
        }
      }
    };

    const flushBuffer = (controller: TransformStreamDefaultController) => {
      if (currentToolCall) {
        const unfinishedCall = `<${currentToolCall.name}>${buffer}`;
        flushText(controller, unfinishedCall);
      } else if (buffer) {
        flushText(controller);
      }

      if (currentTextId) {
        controller.enqueue({ type: "text-end", id: currentTextId });
      }
    };

    return new TransformStream({
      transform(chunk, controller) {
        processChunk(chunk, controller);
      },
      flush(controller) {
        flushBuffer(controller);
      },
    });
  },

  extractToolCallSegments({ text, tools }) {
    const toolNames = tools.map((t) => t.name).filter(Boolean) as string[];
    if (toolNames.length === 0) {
      return [];
    }

    return findToolCalls(text, toolNames).map((tc) => tc.segment);
  },
});

export function getToolSchema(
  tools: LanguageModelV2FunctionTool[],
  toolName: string
) {
  return tools.find((t) => t.name === toolName)?.inputSchema;
}

function computeFullTagEnd(
  text: string,
  contentEnd: number,
  toolName: string
): number {
  let fullTagEnd = contentEnd + `</${toolName}>`.length;
  const closeHead = text.indexOf(`</${toolName}`, contentEnd);
  if (closeHead === contentEnd) {
    let p = closeHead + 2 + toolName.length;
    while (p < text.length && WHITESPACE_REGEX.test(text[p])) {
      p++;
    }
    if (text[p] === ">") {
      fullTagEnd = p + 1;
    }
  }
  return fullTagEnd;
}

function extractToolCallInfo(
  text: string,
  tagStart: number,
  toolName: string,
  range: { start: number; end: number }
): {
  toolName: string;
  startIndex: number;
  endIndex: number;
  content: string;
  segment: string;
} {
  const startTag = `<${toolName}>`;
  const contentStart = tagStart + startTag.length;
  const contentEnd = contentStart + (range.end - range.start);
  const fullTagEnd = computeFullTagEnd(text, contentEnd, toolName);
  const segment = text.substring(tagStart, fullTagEnd);
  const content =
    extractRawInner(segment, toolName) ??
    text.substring(contentStart, contentEnd);

  return {
    toolName,
    startIndex: tagStart,
    endIndex: fullTagEnd,
    content,
    segment,
  };
}

function findToolCallsForName(
  text: string,
  toolName: string
): Array<{
  toolName: string;
  startIndex: number;
  endIndex: number;
  content: string;
  segment: string;
}> {
  const toolCalls: Array<{
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
    segment: string;
  }> = [];
  const startTag = `<${toolName}>`;
  let searchIndex = 0;

  while (searchIndex < text.length) {
    const tagStart = text.indexOf(startTag, searchIndex);
    if (tagStart === -1) {
      break;
    }

    const remainingText = text.substring(tagStart);
    const range = findFirstTopLevelRange(remainingText, toolName);
    if (range) {
      const toolCallInfo = extractToolCallInfo(text, tagStart, toolName, range);
      toolCalls.push(toolCallInfo);
      searchIndex = toolCallInfo.endIndex;
    } else {
      searchIndex = tagStart + startTag.length;
    }
  }

  return toolCalls;
}

// Shared helper to find tool call ranges for a given set of tool names
function findToolCalls(
  text: string,
  toolNames: string[]
): Array<{
  toolName: string;
  startIndex: number;
  endIndex: number;
  content: string;
  segment: string;
}> {
  const toolCalls: Array<{
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
    segment: string;
  }> = [];

  for (const toolName of toolNames) {
    const calls = findToolCallsForName(text, toolName);
    toolCalls.push(...calls);
  }

  return toolCalls.sort((a, b) => a.startIndex - b.startIndex);
}
