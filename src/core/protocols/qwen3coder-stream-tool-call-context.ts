import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { generateToolCallId } from "../utils/id";
import type { QwenRawArguments } from "./qwen3coder-stream-call-content";
import type {
  StreamController,
  StreamingCallState,
  ToolCallContainerState,
} from "./qwen3coder-stream-types";

interface CallConsumption {
  readonly done: boolean;
  readonly remainder: string;
}

export interface ProcessingContext {
  readonly consumeCall: (
    controller: StreamController,
    callState: StreamingCallState,
    content: string,
    fallbackToolName: string | null
  ) => CallConsumption;
  readonly finalizeCall: (
    controller: StreamController,
    callState: StreamingCallState,
    fallbackToolName: string | null,
    rawToolCallText: string | null
  ) => boolean;
  readonly flushSafeTextPrefix: (controller: StreamController) => void;
  readonly getBuffer: () => string;
  readonly getToolCall: () => ToolCallContainerState | null;
  readonly maybeEmitToolInputStart: (
    controller: StreamController,
    callState: StreamingCallState
  ) => void;
  readonly setBuffer: (buffer: string) => void;
  readonly setToolCall: (toolCall: ToolCallContainerState | null) => void;
  readonly startToolCallIfPresent: () => void;
  readonly tools: LanguageModelV4FunctionTool[];
}

export function createStreamingCall(
  endTagName: string,
  toolName: string | null,
  raw: string
): StreamingCallState {
  return {
    endTagName,
    toolCallId: generateToolCallId(),
    toolName,
    hasEmittedStart: false,
    partialParam: null,
    emittedInput: "",
    pendingToolInputParts: [],
    raw,
    args: Object.create(null) as QwenRawArguments,
    buffer: "",
  };
}
