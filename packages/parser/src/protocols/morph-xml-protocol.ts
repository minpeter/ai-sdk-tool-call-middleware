import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3ToolCall,
  LanguageModelV3ToolResultPart,
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
  processedElements: LanguageModelV3Content[]
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
  tools: LanguageModelV3FunctionTool[];
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  text: string;
  processedElements: LanguageModelV3Content[];
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
  processedElements: LanguageModelV3Content[]
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
  tools: LanguageModelV3FunctionTool[];
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  ctrl: TransformStreamDefaultController;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
};

function handleStreamingToolCallEnd(params: StreamingToolCallEndParams): void {
  const { toolContent, currentToolCall, tools, options, ctrl, flushText } =
    params;
  try {
    const toolSchema = getToolSchema(tools, currentToolCall.name);
    const parsed: unknown = parse(toolContent, toolSchema, {
      onError: options?.onError,
      noChildNodes: [],
    });

    // Close any open text segment before emitting tool-call
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
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  ctrl: TransformStreamDefaultController;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
};

function handleStreamingToolCallError(
  params: StreamingToolCallErrorParams
): void {
  const { error, currentToolCall, toolContent, options, ctrl, flushText } =
    params;
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
  tools: LanguageModelV3FunctionTool[];
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  controller: TransformStreamDefaultController;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
  setBuffer: (buffer: string) => void;
};

function processToolCallInBuffer(params: ProcessToolCallInBufferParams): {
  buffer: string;
  currentToolCall: { name: string; content: string } | null;
  shouldBreak: boolean;
} {
  const {
    buffer,
    currentToolCall,
    tools,
    options,
    controller,
    flushText,
    setBuffer,
  } = params;
  const endTag = `</${currentToolCall.name}>`;
  const endTagIndex = buffer.indexOf(endTag);

  if (endTagIndex !== -1) {
    const toolContent = buffer.substring(0, endTagIndex);
    const newBuffer = buffer.substring(endTagIndex + endTag.length);

    // Clear buffer BEFORE calling handleStreamingToolCallEnd
    // so that flushText(ctrl) emits text-end without emitting buffer content
    setBuffer("");

    handleStreamingToolCallEnd({
      toolContent,
      currentToolCall,
      tools,
      options,
      ctrl: controller,
      flushText,
    });

    // Restore buffer to content after tool call
    setBuffer(newBuffer);
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

function processNoToolCallInBuffer(params: ProcessNoToolCallInBufferParams): {
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

function createFlushTextHandler(
  getBuffer: () => string,
  setBuffer: (buffer: string) => void,
  getCurrentTextId: () => string | null,
  setCurrentTextId: (id: string | null) => void
) {
  return (controller: TransformStreamDefaultController, text?: string) => {
    const content = text ?? getBuffer();
    if (content) {
      const currentTextId = getCurrentTextId();
      if (!currentTextId) {
        const newId = generateId();
        setCurrentTextId(newId);
        controller.enqueue({ type: "text-start", id: newId });
      }
      controller.enqueue({
        type: "text-delta",
        id: getCurrentTextId() as string,
        delta: content,
      });
      if (text === undefined) {
        setBuffer("");
      }
    }

    const currentTextId = getCurrentTextId();
    if (currentTextId && !text) {
      controller.enqueue({ type: "text-end", id: currentTextId });
      setCurrentTextId(null);
    }
  };
}

type ProcessBufferHandlerParams = {
  getBuffer: () => string;
  setBuffer: (buffer: string) => void;
  getCurrentToolCall: () => { name: string; content: string } | null;
  setCurrentToolCall: (
    toolCall: { name: string; content: string } | null
  ) => void;
  tools: LanguageModelV3FunctionTool[];
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  toolNames: string[];
  maxStartTagLen: number;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
};

function processBufferWithToolCall(
  params: ProcessBufferHandlerParams,
  controller: TransformStreamDefaultController
): boolean {
  const {
    getBuffer,
    setBuffer,
    getCurrentToolCall,
    setCurrentToolCall,
    tools,
    options,
    flushText,
  } = params;
  const currentToolCall = getCurrentToolCall();

  if (!currentToolCall) {
    return true;
  }

  const result = processToolCallInBuffer({
    buffer: getBuffer(),
    currentToolCall,
    tools,
    options,
    controller,
    flushText,
    setBuffer,
  });
  setBuffer(result.buffer);
  setCurrentToolCall(result.currentToolCall);
  return result.shouldBreak;
}

function processBufferWithoutToolCall(
  params: ProcessBufferHandlerParams,
  controller: TransformStreamDefaultController
): { shouldBreak: boolean; shouldContinue: boolean } {
  const {
    getBuffer,
    setBuffer,
    setCurrentToolCall,
    toolNames,
    maxStartTagLen,
    flushText,
  } = params;

  const result = processNoToolCallInBuffer({
    buffer: getBuffer(),
    toolNames,
    maxStartTagLen,
    controller,
    flushText,
  });
  setBuffer(result.buffer);
  setCurrentToolCall(result.currentToolCall);
  return {
    shouldBreak: result.shouldBreak,
    shouldContinue: result.shouldContinue,
  };
}

function processBufferLoop(
  params: ProcessBufferHandlerParams,
  controller: TransformStreamDefaultController
): void {
  while (true) {
    const currentToolCall = params.getCurrentToolCall();
    if (currentToolCall) {
      const shouldBreak = processBufferWithToolCall(params, controller);
      if (shouldBreak) {
        break;
      }
    } else {
      const { shouldBreak, shouldContinue } = processBufferWithoutToolCall(
        params,
        controller
      );
      if (shouldContinue) {
        continue;
      }
      if (shouldBreak) {
        break;
      }
    }
  }
}

function createProcessBufferHandler(params: ProcessBufferHandlerParams) {
  return (controller: TransformStreamDefaultController) => {
    processBufferLoop(params, controller);
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

  formatToolCall(toolCall: LanguageModelV3ToolCall): string {
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

  formatToolResponse(toolResult: LanguageModelV3ToolResultPart): string {
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

    const processedElements: LanguageModelV3Content[] = [];
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

    const flushText = createFlushTextHandler(
      () => buffer,
      (newBuffer: string) => {
        buffer = newBuffer;
      },
      () => currentTextId,
      (newId: string | null) => {
        currentTextId = newId;
      }
    );

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

    const processBuffer = createProcessBufferHandler({
      getBuffer: () => buffer,
      setBuffer: (newBuffer: string) => {
        buffer = newBuffer;
      },
      getCurrentToolCall: () => currentToolCall,
      setCurrentToolCall: (
        newToolCall: { name: string; content: string } | null
      ) => {
        currentToolCall = newToolCall;
      },
      tools,
      options,
      toolNames,
      maxStartTagLen,
      flushText,
    });

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
  tools: LanguageModelV3FunctionTool[],
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
      p += 1;
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
