import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { escapeRegExp } from "../utils/regex";
import { findEarliestToolTag } from "../utils/xml-tool-tag-scanner";
import type { ParserOptions } from "./protocol-interface";

export interface StreamingToolCallState {
  emittedInput: string;
  hasEmittedStart: boolean;
  lastProgressContentLength: number | null;
  lastProgressFullInput: string | null;
  lastProgressGtIndex: number | null;
  name: string;
  pendingToolInputParts: LanguageModelV4StreamPart[];
  toolCallId: string;
}

export interface LinePrefixedToolCall {
  content: string;
  endIndex: number;
  startIndex: number;
  toolName: string;
}

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;

export type FlushTextFn = (controller: StreamController, text?: string) => void;

type HandleStreamingToolCallEnd = (params: {
  ctrl: StreamController;
  currentToolCall: StreamingToolCallState;
  flushText: FlushTextFn;
  options?: ParserOptions;
  parseOptions?: Record<string, unknown>;
  toolContent: string;
  tools: LanguageModelV4FunctionTool[];
}) => void;

interface ProcessToolCallInBufferParams {
  buffer: string;
  controller: StreamController;
  currentToolCall: StreamingToolCallState;
  emitToolInputProgress: (
    controller: StreamController,
    currentToolCall: StreamingToolCallState,
    toolContent: string
  ) => void;
  flushText: FlushTextFn;
  handleStreamingToolCallEnd: HandleStreamingToolCallEnd;
  options?: ParserOptions;
  parseOptions?: Record<string, unknown>;
  setBuffer: (buffer: string) => void;
  tools: LanguageModelV4FunctionTool[];
}

function processToolCallInBuffer(params: ProcessToolCallInBufferParams): {
  buffer: string;
  currentToolCall: StreamingToolCallState | null;
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
    parseOptions,
    emitToolInputProgress,
    handleStreamingToolCallEnd,
  } = params;
  const endTagPattern = new RegExp(
    `</\\s*${escapeRegExp(currentToolCall.name)}\\s*>`
  );
  const endMatch = endTagPattern.exec(buffer);
  if (!endMatch || endMatch.index === undefined) {
    emitToolInputProgress(controller, currentToolCall, buffer);
    return { buffer, currentToolCall, shouldBreak: true };
  }

  const endIdx = endMatch.index;
  const endPos = endIdx + endMatch[0].length;
  const content = buffer.slice(0, endIdx);
  emitToolInputProgress(controller, currentToolCall, content);
  const remainder = buffer.slice(endPos);
  setBuffer(remainder);

  handleStreamingToolCallEnd({
    toolContent: content,
    currentToolCall,
    tools,
    options,
    ctrl: controller,
    flushText,
    parseOptions,
  });

  return {
    buffer: remainder,
    currentToolCall: null,
    shouldBreak: false,
  };
}

interface ProcessNoToolCallInBufferParams {
  allowLinePrefixedCallAtBufferEnd: boolean;
  buffer: string;
  controller: StreamController;
  emitToolInputStart: (
    controller: StreamController,
    toolName: string
  ) => StreamingToolCallState;
  findLinePrefixedToolCall: (
    buffer: string,
    toolNames: string[],
    allowAtBufferEnd: boolean
  ) => LinePrefixedToolCall | null;
  findPotentialLinePrefixedToolCallStart: (
    buffer: string,
    toolNames: string[]
  ) => number;
  findPotentialToolTagStart: (buffer: string, toolNames: string[]) => number;
  flushText: FlushTextFn;
  handleStreamingToolCallEnd: HandleStreamingToolCallEnd;
  options?: ParserOptions;
  parseOptions?: Record<string, unknown>;
  setBuffer: (buffer: string) => void;
  toolNames: string[];
  tools: LanguageModelV4FunctionTool[];
}

function processLinePrefixedToolCall(options: {
  buffer: string;
  controller: StreamController;
  emitToolInputStart: (
    controller: StreamController,
    toolName: string
  ) => StreamingToolCallState;
  flushText: FlushTextFn;
  handleStreamingToolCallEnd: HandleStreamingToolCallEnd;
  linePrefixedCall: LinePrefixedToolCall;
  parserOptions?: ParserOptions;
  parseOptions?: Record<string, unknown>;
  setBuffer: (buffer: string) => void;
  tools: LanguageModelV4FunctionTool[];
}): {
  buffer: string;
  currentToolCall: null;
  shouldBreak: false;
  shouldContinue: true;
} {
  const { linePrefixedCall } = options;
  options.flushText(
    options.controller,
    options.buffer.slice(0, linePrefixedCall.startIndex)
  );
  const newBuffer = options.buffer.slice(linePrefixedCall.endIndex);
  options.setBuffer(newBuffer);
  const currentToolCall = options.emitToolInputStart(
    options.controller,
    linePrefixedCall.toolName
  );
  options.handleStreamingToolCallEnd({
    toolContent: linePrefixedCall.content,
    currentToolCall,
    tools: options.tools,
    options: options.parserOptions,
    ctrl: options.controller,
    flushText: options.flushText,
    parseOptions: options.parseOptions,
  });
  return {
    buffer: newBuffer,
    currentToolCall: null,
    shouldBreak: false,
    shouldContinue: true,
  };
}

function processNoToolCallInBuffer(params: ProcessNoToolCallInBufferParams): {
  buffer: string;
  currentToolCall: StreamingToolCallState | null;
  shouldBreak: boolean;
  shouldContinue: boolean;
} {
  const {
    buffer,
    toolNames,
    controller,
    flushText,
    tools,
    options,
    parseOptions,
    setBuffer,
    emitToolInputStart,
    findPotentialToolTagStart,
    findLinePrefixedToolCall,
    findPotentialLinePrefixedToolCallStart,
    handleStreamingToolCallEnd,
    allowLinePrefixedCallAtBufferEnd,
  } = params;
  const {
    index: earliestStartTagIndex,
    name: earliestToolName,
    selfClosing,
    tagLength,
  } = findEarliestToolTag(buffer, toolNames);
  const linePrefixedCall = findLinePrefixedToolCall(
    buffer,
    toolNames,
    allowLinePrefixedCallAtBufferEnd
  );
  const potentialLineStart = findPotentialLinePrefixedToolCallStart(
    buffer,
    toolNames
  );
  const potentialTagStart = findPotentialToolTagStart(buffer, toolNames);
  const xmlStarts = [earliestStartTagIndex, potentialTagStart].filter(
    (start) => start >= 0
  );
  const earliestXmlStart = xmlStarts.length === 0 ? -1 : Math.min(...xmlStarts);

  if (
    linePrefixedCall &&
    (earliestStartTagIndex === -1 ||
      linePrefixedCall.startIndex < earliestStartTagIndex)
  ) {
    return processLinePrefixedToolCall({
      buffer,
      controller,
      emitToolInputStart,
      flushText,
      handleStreamingToolCallEnd,
      linePrefixedCall,
      parserOptions: options,
      parseOptions,
      setBuffer,
      tools,
    });
  }

  if (
    potentialLineStart >= 0 &&
    (earliestXmlStart === -1 || potentialLineStart < earliestXmlStart)
  ) {
    const remaining = buffer.slice(potentialLineStart);
    if (potentialLineStart > 0) {
      flushText(controller, buffer.slice(0, potentialLineStart));
      setBuffer(remaining);
    }
    return {
      buffer: remaining,
      currentToolCall: null,
      shouldBreak: true,
      shouldContinue: false,
    };
  }

  if (earliestStartTagIndex === -1) {
    const potentialStarts = [potentialTagStart, potentialLineStart].filter(
      (start) => start >= 0
    );
    const potentialStart =
      potentialStarts.length === 0 ? -1 : Math.min(...potentialStarts);
    const safeLen = Math.max(
      0,
      potentialStart === -1 ? buffer.length : potentialStart
    );
    const remaining = buffer.slice(safeLen);
    if (safeLen > 0) {
      flushText(controller, buffer.slice(0, safeLen));
      setBuffer(remaining);
    }
    return {
      buffer: remaining,
      currentToolCall: null,
      shouldBreak: true,
      shouldContinue: false,
    };
  }

  flushText(controller, buffer.slice(0, earliestStartTagIndex));

  if (selfClosing) {
    const newBuffer = buffer.slice(earliestStartTagIndex + tagLength);
    setBuffer(newBuffer);
    const currentToolCall = emitToolInputStart(controller, earliestToolName);
    handleStreamingToolCallEnd({
      toolContent: "",
      currentToolCall,
      tools,
      options,
      ctrl: controller,
      flushText,
      parseOptions,
    });
    return {
      buffer: newBuffer,
      currentToolCall: null,
      shouldBreak: false,
      shouldContinue: false,
    };
  }

  const startTag = `<${earliestToolName}>`;
  const newBuffer = buffer.slice(earliestStartTagIndex + startTag.length);
  setBuffer(newBuffer);
  return {
    buffer: newBuffer,
    currentToolCall: emitToolInputStart(controller, earliestToolName),
    shouldBreak: false,
    shouldContinue: true,
  };
}

export function createProcessBufferHandler(options: {
  getBuffer: () => string;
  setBuffer: (buffer: string) => void;
  getCurrentToolCall: () => StreamingToolCallState | null;
  setCurrentToolCall: (toolCall: StreamingToolCallState | null) => void;
  tools: LanguageModelV4FunctionTool[];
  parserOptions: ParserOptions | undefined;
  toolNames: string[];
  flushText: FlushTextFn;
  parseOptions: Record<string, unknown> | undefined;
  emitToolInputProgress: (
    controller: StreamController,
    currentToolCall: StreamingToolCallState,
    toolContent: string
  ) => void;
  emitToolInputStart: (
    controller: StreamController,
    toolName: string
  ) => StreamingToolCallState;
  findPotentialToolTagStart: (buffer: string, toolNames: string[]) => number;
  findLinePrefixedToolCall: (
    buffer: string,
    toolNames: string[],
    allowAtBufferEnd: boolean
  ) => LinePrefixedToolCall | null;
  findPotentialLinePrefixedToolCallStart: (
    buffer: string,
    toolNames: string[]
  ) => number;
  handleStreamingToolCallEnd: HandleStreamingToolCallEnd;
}): (
  controller: StreamController,
  allowLinePrefixedCallAtBufferEnd?: boolean
) => void {
  return (controller, allowLinePrefixedCallAtBufferEnd = false) => {
    while (true) {
      const currentToolCall = options.getCurrentToolCall();
      if (currentToolCall) {
        const result = processToolCallInBuffer({
          buffer: options.getBuffer(),
          currentToolCall,
          tools: options.tools,
          options: options.parserOptions,
          controller,
          flushText: options.flushText,
          setBuffer: options.setBuffer,
          parseOptions: options.parseOptions,
          emitToolInputProgress: options.emitToolInputProgress,
          handleStreamingToolCallEnd: options.handleStreamingToolCallEnd,
        });
        options.setBuffer(result.buffer);
        options.setCurrentToolCall(result.currentToolCall);
        if (result.shouldBreak) {
          break;
        }
      } else {
        const result = processNoToolCallInBuffer({
          buffer: options.getBuffer(),
          toolNames: options.toolNames,
          controller,
          flushText: options.flushText,
          tools: options.tools,
          options: options.parserOptions,
          parseOptions: options.parseOptions,
          setBuffer: options.setBuffer,
          emitToolInputStart: options.emitToolInputStart,
          findPotentialToolTagStart: options.findPotentialToolTagStart,
          findLinePrefixedToolCall: options.findLinePrefixedToolCall,
          findPotentialLinePrefixedToolCallStart:
            options.findPotentialLinePrefixedToolCallStart,
          handleStreamingToolCallEnd: options.handleStreamingToolCallEnd,
          allowLinePrefixedCallAtBufferEnd,
        });
        options.setBuffer(result.buffer);
        options.setCurrentToolCall(result.currentToolCall);
        if (result.shouldBreak) {
          break;
        }
        if (result.shouldContinue) {
          continue;
        }
        break;
      }
    }
  };
}
