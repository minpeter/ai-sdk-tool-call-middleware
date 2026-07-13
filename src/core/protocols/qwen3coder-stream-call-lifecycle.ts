import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import {
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import {
  emitBufferedToolInputProgressDelta,
  emitFailedBufferedToolInputLifecycle,
  emitFinalizedBufferedToolInputLifecycle,
  isPrototypeSensitiveToolCallInputError,
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import type { ParserOptions } from "./protocol-interface";
import {
  mergeArgsWithPartialParam,
  mergeParamValue,
} from "./qwen3coder-call-parsing";
import {
  buildSchemaParamNameMap,
  QWEN3CODER_TOOL_PARSER_STREAM_NAME_TAG_RE,
  sanitizePartialParamValueForProgress,
} from "./qwen3coder-call-syntax";
import {
  normalizeXmlTextValue,
  parseQwen3CoderToolParserParamTagAt,
} from "./qwen3coder-param-tag-parsing";
import { parseCallContent } from "./qwen3coder-stream-call-content";
import type {
  StreamController,
  StreamingCallState,
} from "./qwen3coder-stream-types";

type FlushText = (controller: StreamController, text?: string) => void;

export function createQwenStreamCallLifecycle({
  flushText,
  options,
  tools,
}: {
  flushText: FlushText;
  options?: ParserOptions;
  tools: LanguageModelV4FunctionTool[];
}) {
  // Bounded by the tool set: one entry per resolved tool name per stream.
  const schemaParamNameCache = new Map<string, Map<string, string> | null>();
  const getSchemaParamNames = (
    toolName: string | null
  ): Map<string, string> | null => {
    if (!toolName) {
      return null;
    }
    let cached = schemaParamNameCache.get(toolName);
    if (cached === undefined) {
      cached = buildSchemaParamNameMap(toolName, tools);
      schemaParamNameCache.set(toolName, cached);
    }
    return cached;
  };

  const getProgressHoldbackTags = (callState: StreamingCallState): string[] => {
    const extra: string[] = [`</${callState.endTagName}>`];
    const schemaParamNames = getSchemaParamNames(callState.toolName);
    if (schemaParamNames) {
      for (const nameLower of schemaParamNames.keys()) {
        extra.push(`<${nameLower}>`, `</${nameLower}>`);
      }
    }
    return extra;
  };
  const maybeEmitToolInputStart = (
    controller: StreamController,
    callState: StreamingCallState
  ) => {
    if (callState.hasEmittedStart) {
      return;
    }
    const { toolName } = callState;
    if (!toolName || toolName.trim().length === 0) {
      return;
    }
    flushText(controller);
    controller.enqueue({
      type: "tool-input-start",
      id: callState.toolCallId,
      toolName,
    });
    callState.hasEmittedStart = true;
  };

  const maybeEmitToolInputProgress = (
    _controller: StreamController,
    callState: StreamingCallState
  ) => {
    if (!callState.hasEmittedStart) {
      return;
    }
    const { toolName } = callState;
    if (!toolName) {
      return;
    }
    const argsForProgress = mergeArgsWithPartialParam(
      callState.args,
      sanitizePartialParamValueForProgress(
        callState.partialParam,
        getProgressHoldbackTags(callState)
      )
    );
    let fullInput: string;
    try {
      fullInput = stringifyToolInputWithSchema({
        tools,
        toolName,
        args: argsForProgress,
      });
    } catch {
      return;
    }
    if (fullInput === "{}") {
      return;
    }
    emitBufferedToolInputProgressDelta({
      enqueue: (part) => {
        callState.pendingToolInputParts.push(part);
      },
      id: callState.toolCallId,
      state: callState,
      fullInput,
    });
  };

  const failUnresolvedStreamingCall = (params: {
    callState: StreamingCallState;
    controller: StreamController;
    fallbackToolName: string | null;
    rawToolCallText: string | null;
  }): false => {
    const { callState, controller, fallbackToolName, rawToolCallText } = params;
    const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
    emitFailedBufferedToolInputLifecycle({
      bufferedParts: callState.pendingToolInputParts,
      controller,
      id: callState.toolCallId,
      emitRawToolCallTextOnError: shouldEmitRaw,
      endInputOnError: callState.hasEmittedStart,
      rawToolCallText,
      emitRawText: (rawText) => {
        flushText(controller, rawText);
      },
    });
    options?.onError?.(
      shouldEmitRaw && rawToolCallText
        ? "Could not resolve Qwen3CoderToolParser tool name for tool call; emitting original text."
        : "Could not resolve Qwen3CoderToolParser tool name for tool call",
      {
        toolCallId: callState.toolCallId,
        toolCall: safeToolCallMetadataText(rawToolCallText),
        toolName: callState.toolName ?? fallbackToolName ?? undefined,
        dropReason: "unresolved-tool-name",
      }
    );
    return false;
  };

  const failSensitiveStreamingCall = (params: {
    callState: StreamingCallState;
    controller: StreamController;
    rawToolCallText: string;
    resolvedToolName: string;
  }): false => {
    const { callState, controller, rawToolCallText, resolvedToolName } = params;
    const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
    const error = new Error(
      "Tool call arguments contain prototype-sensitive keys"
    );
    emitFailedBufferedToolInputLifecycle({
      bufferedParts: callState.pendingToolInputParts,
      controller,
      id: callState.toolCallId,
      emitRawToolCallTextOnError: shouldEmitRaw,
      endInputOnError: callState.hasEmittedStart,
      hideBufferedInputOnError: true,
      rawToolCallText,
      emitRawText: (rawText) => {
        flushText(controller, rawText);
      },
    });
    options?.onError?.(
      shouldEmitRaw
        ? "Could not process streaming Qwen3CoderToolParser XML tool call; emitting original text."
        : "Could not process streaming Qwen3CoderToolParser XML tool call.",
      {
        toolCallId: callState.toolCallId,
        toolCall: safeToolCallMetadataText(rawToolCallText),
        toolName: resolvedToolName,
        dropReason: "malformed-tool-call-body",
        error: safeToolCallMetadataError(error, rawToolCallText),
      }
    );
    return false;
  };

  const finalizeCall = (
    controller: StreamController,
    callState: StreamingCallState,
    fallbackToolName: string | null,
    rawToolCallText: string | null = null
  ): boolean => {
    const resolvedToolName = callState.toolName ?? fallbackToolName;
    if (!resolvedToolName || resolvedToolName.trim().length === 0) {
      return failUnresolvedStreamingCall({
        callState,
        controller,
        fallbackToolName,
        rawToolCallText,
      });
    }

    callState.toolName = resolvedToolName;

    if (
      rawToolCallText &&
      toolCallTextHasPrototypeSensitiveKey(rawToolCallText)
    ) {
      return failSensitiveStreamingCall({
        callState,
        controller,
        rawToolCallText,
        resolvedToolName,
      });
    }

    maybeEmitToolInputStart(controller, callState);
    maybeEmitToolInputProgress(controller, callState);

    let finalInput: string;
    try {
      finalInput = stringifyToolInputWithSchema({
        tools,
        toolName: resolvedToolName,
        args: callState.args,
      });
    } catch (error) {
      const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
      emitFailedBufferedToolInputLifecycle({
        bufferedParts: callState.pendingToolInputParts,
        controller,
        id: callState.toolCallId,
        emitRawToolCallTextOnError: shouldEmitRaw,
        endInputOnError: callState.hasEmittedStart,
        hideBufferedInputOnError: isPrototypeSensitiveToolCallInputError(error),
        rawToolCallText,
        emitRawText: (rawText) => {
          flushText(controller, rawText);
        },
      });
      options?.onError?.(
        shouldEmitRaw && rawToolCallText
          ? "Could not process streaming Qwen3CoderToolParser XML tool call; emitting original text."
          : "Could not process streaming Qwen3CoderToolParser XML tool call.",
        {
          toolCallId: callState.toolCallId,
          toolCall: safeToolCallMetadataText(rawToolCallText),
          toolName: resolvedToolName,
          dropReason: "malformed-tool-call-body",
          error: safeToolCallMetadataError(error, rawToolCallText),
        }
      );
      return false;
    }
    emitFinalizedBufferedToolInputLifecycle({
      bufferedParts: callState.pendingToolInputParts,
      controller,
      id: callState.toolCallId,
      state: callState,
      toolName: resolvedToolName,
      finalInput,
      onMismatch: options?.onError,
    });
    return true;
  };

  const parseStreamingCallContent = (
    controller: StreamController,
    callState: StreamingCallState,
    content: string,
    allowEndOfString: boolean
  ): string =>
    parseCallContent({
      callState,
      content,
      allowEndOfString,
      nameTagRe: QWEN3CODER_TOOL_PARSER_STREAM_NAME_TAG_RE,
      normalizeXmlTextValue,
      parseParamTagAt: (text, lowerText, startIndex, parseOptions) =>
        parseQwen3CoderToolParserParamTagAt(text, lowerText, startIndex, {
          ...parseOptions,
          schemaParamNames: getSchemaParamNames(callState.toolName),
        }),
      mergeParamValue,
      maybeEmitToolInputStart: () => {
        maybeEmitToolInputStart(controller, callState);
      },
      maybeEmitToolInputProgress: () => {
        maybeEmitToolInputProgress(controller, callState);
      },
    });

  return {
    finalizeCall,
    maybeEmitToolInputStart,
    parseStreamingCallContent,
  };
}
