import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { findEarliestToolTag } from "../utils/xml-tool-tag-scanner";
import type { ParserOptions } from "./protocol-interface";

export interface StreamingToolCallState {
  emittedInput: string;
  lastProgressContentLength: number | null;
  lastProgressFullInput: string | null;
  lastProgressGtIndex: number | null;
  name: string;
  toolCallId: string;
}

type StreamController =
  TransformStreamDefaultController<LanguageModelV3StreamPart>;

export type FlushTextFn = (controller: StreamController, text?: string) => void;

type HandleStreamingToolCallEnd = (params: {
  ctrl: StreamController;
  currentToolCall: StreamingToolCallState;
  flushText: FlushTextFn;
  options?: ParserOptions;
  parseOptions?: Record<string, unknown>;
  toolContent: string;
  tools: LanguageModelV3FunctionTool[];
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
  tools: LanguageModelV3FunctionTool[];
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
  const endTagPattern = new RegExp(`</\\s*${currentToolCall.name}\\s*>`);
  const endMatch = endTagPattern.exec(buffer);
  if (!endMatch || endMatch.index === undefined) {
    emitToolInputProgress(controller, currentToolCall, buffer);
    return { buffer, currentToolCall, shouldBreak: true };
  }

  const endIdx = endMatch.index;
  const endPos = endIdx + endMatch[0].length;
  const content = buffer.substring(0, endIdx);
  emitToolInputProgress(controller, currentToolCall, content);
  const remainder = buffer.substring(endPos);
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
  buffer: string;
  controller: StreamController;
  emitToolInputStart: (
    controller: StreamController,
    toolName: string
  ) => StreamingToolCallState;
  findPotentialToolTagStart: (buffer: string, toolNames: string[]) => number;
  flushText: FlushTextFn;
  handleStreamingToolCallEnd: HandleStreamingToolCallEnd;
  options?: ParserOptions;
  parseOptions?: Record<string, unknown>;
  setBuffer: (buffer: string) => void;
  toolNames: string[];
  tools: LanguageModelV3FunctionTool[];
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
    handleStreamingToolCallEnd,
  } = params;
  const {
    index: earliestStartTagIndex,
    name: earliestToolName,
    selfClosing,
    tagLength,
  } = findEarliestToolTag(buffer, toolNames);

  if (earliestStartTagIndex === -1) {
    const potentialStart = findPotentialToolTagStart(buffer, toolNames);
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

  flushText(controller, buffer.substring(0, earliestStartTagIndex));

  if (selfClosing) {
    const newBuffer = buffer.substring(earliestStartTagIndex + tagLength);
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
  const newBuffer = buffer.substring(earliestStartTagIndex + startTag.length);
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
  tools: LanguageModelV3FunctionTool[];
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
  handleStreamingToolCallEnd: HandleStreamingToolCallEnd;
}): (controller: StreamController) => void {
  return (controller: StreamController) => {
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
          handleStreamingToolCallEnd: options.handleStreamingToolCallEnd,
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
