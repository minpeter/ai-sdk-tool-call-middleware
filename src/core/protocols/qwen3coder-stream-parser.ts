import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { getPotentialStartIndex } from "../utils/get-potential-start-index";
import { generateToolCallId } from "../utils/id";
import { createFlushTextHandler } from "../utils/protocol-utils";
import { shouldEmitRawToolCallTextOnError } from "../utils/tool-input-streaming";
import type { ParserOptions } from "./protocol-interface";
import {
  getPotentialTagStartIndex,
  normalizeToolCallInnerOpenVariants,
  QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE,
  stripLeadingToolCallCloseTags,
  TOOL_CALL_OPEN_RE,
} from "./qwen3coder-call-syntax";
import {
  getAttributeValue,
  getShorthandValue,
} from "./qwen3coder-param-tag-parsing";
import { createQwenStreamCallConsumption } from "./qwen3coder-stream-call-consumption";
import type { QwenRawArguments } from "./qwen3coder-stream-call-content";
import { createQwenStreamCallLifecycle } from "./qwen3coder-stream-call-lifecycle";
import { createQwenStreamFinishReporting } from "./qwen3coder-stream-finish-reporting";
import { createQwenStreamTextRecovery } from "./qwen3coder-stream-text-recovery";
import { createQwenStreamToolCallProcessor } from "./qwen3coder-stream-tool-call-processing";
import type {
  StreamController,
  StreamingCallState,
  ToolCallContainerState,
} from "./qwen3coder-stream-types";

export function createQwen3CoderStreamParser({
  tools,
  options,
}: {
  tools: LanguageModelV4FunctionTool[];
  options?: ParserOptions;
}): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  const toolCallStartPrefixLower = "<tool_call";

  // vLLM reference (Qwen3XMLToolParser): streaming tool calls can start directly
  // with <function=...> (missing opening <tool_call>), and the parser implicitly
  // starts a tool_call container.
  // https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3xml_tool_parser.py#L595-L642
  // https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/tests/tool_parsers/test_qwen3coder_tool_parser.py#L901-L922
  const implicitCallPrefixesLower = ["<function", "<call", "<tool", "<invoke"];
  const standaloneParamPrefixesLower = [
    "<parameter",
    "<param",
    "<argument",
    "<arg",
  ];

  let buffer = "";
  let toolCall: ToolCallContainerState | null = null;
  let implicitCall: StreamingCallState | null = null;
  let implicitCallOpenTag: string | null = null;
  let currentTextId: string | null = null;
  let hasEmittedTextStart = false;

  const flushText = createFlushTextHandler(
    () => currentTextId,
    (id) => {
      currentTextId = id;
    },
    () => hasEmittedTextStart,
    (value) => {
      hasEmittedTextStart = value;
    }
  );

  const { flushRecoveredBufferText, flushRecoveredTrailingText } =
    createQwenStreamTextRecovery({ flushText, options });

  const { finalizeCall, maybeEmitToolInputStart, parseStreamingCallContent } =
    createQwenStreamCallLifecycle({ flushText, options, tools });

  const { consumeCall, disableScanDeferral, finalizeCallAtFinish } =
    createQwenStreamCallConsumption({
      finalizeCall,
      onFinalized: () => {
        if (toolCall) {
          toolCall.emittedToolCallCount += 1;
        }
      },
      parseStreamingCallContent,
    });

  const flushSafeTextPrefix = (controller: StreamController) => {
    const lower = buffer.toLowerCase();

    const potentialIndices = [
      getPotentialTagStartIndex(lower, toolCallStartPrefixLower),
      ...implicitCallPrefixesLower.map((prefix) =>
        getPotentialTagStartIndex(lower, prefix)
      ),
      ...standaloneParamPrefixesLower.map((prefix) =>
        getPotentialTagStartIndex(lower, prefix)
      ),
    ].filter((value): value is number => value != null);

    const potentialIndex =
      potentialIndices.length > 0 ? Math.min(...potentialIndices) : null;
    if (potentialIndex == null) {
      if (buffer.length > 0) {
        flushRecoveredBufferText(controller, buffer);
        buffer = "";
      }
      return;
    }

    if (potentialIndex > 0) {
      flushText(controller, buffer.slice(0, potentialIndex));
      buffer = buffer.slice(potentialIndex);
    }
  };

  const stripLeadingToolCallCloseTagsFromBuffer = () => {
    if (!buffer) {
      return;
    }
    const stripped = stripLeadingToolCallCloseTags(buffer);
    if (stripped !== buffer) {
      buffer = stripped;
    }
  };

  const startToolCallIfPresent = () => {
    const lower = buffer.toLowerCase();
    const startIndex = getPotentialStartIndex(lower, toolCallStartPrefixLower);
    if (startIndex == null || startIndex !== 0) {
      return;
    }

    const gtIndex = buffer.indexOf(">");
    if (gtIndex === -1) {
      return;
    }

    const openTag = buffer.slice(0, gtIndex + 1);
    if (!TOOL_CALL_OPEN_RE.test(openTag)) {
      return;
    }

    toolCall = {
      outerOpenTag: openTag,
      outerNameAttr: getAttributeValue(openTag, "name"),
      raw: openTag,
      mode: "unknown",
      innerBuffer: "",
      activeCall: null,
      emittedToolCallCount: 0,
    };

    const remainder = buffer.slice(gtIndex + 1);
    buffer = "";
    if (remainder.length > 0) {
      toolCall.raw += remainder;
      toolCall.innerBuffer += remainder;
    }
  };

  const startImplicitCallIfPresent = (controller: StreamController) => {
    const match = QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE.exec(buffer);
    const startIndex = match?.index ?? -1;
    const openTag = match?.[0] ?? "";
    const callTagName = (match?.[1] ?? "").toLowerCase();
    if (!match || startIndex !== 0 || !openTag || !callTagName) {
      return;
    }

    const inlineToolName =
      getAttributeValue(openTag, "name") ?? getShorthandValue(openTag);
    if (!inlineToolName || inlineToolName.trim().length === 0) {
      return;
    }
    const selfClosing =
      QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE.test(openTag);

    buffer = buffer.slice(openTag.length);

    const newCall: StreamingCallState = {
      endTagName: callTagName,
      toolCallId: generateToolCallId(),
      toolName: inlineToolName,
      hasEmittedStart: false,
      partialParam: null,
      emittedInput: "",
      pendingToolInputParts: [],
      raw: openTag,
      args: Object.create(null) as QwenRawArguments,
      buffer: "",
    };

    maybeEmitToolInputStart(controller, newCall);

    if (selfClosing) {
      finalizeCall(controller, newCall, inlineToolName, newCall.raw);
      return;
    }

    implicitCall = newCall;
    implicitCallOpenTag = openTag;
  };

  const processImplicitCall = (controller: StreamController) => {
    while (implicitCall) {
      const callState = implicitCall;
      const { done, remainder } = consumeCall(
        controller,
        callState,
        buffer,
        null
      );
      buffer = "";
      if (!done) {
        return;
      }

      implicitCall = null;
      implicitCallOpenTag = null;
      if (remainder.length > 0) {
        buffer = remainder;
      }

      stripLeadingToolCallCloseTagsFromBuffer();
      flushSafeTextPrefix(controller);
      startToolCallIfPresent();
      if (toolCall) {
        processToolCall(controller);
        return;
      }
      startImplicitCallIfPresent(controller);
    }
  };

  const drainStarts = (controller: StreamController) => {
    while (true) {
      const before = buffer;
      startToolCallIfPresent();
      if (toolCall) {
        processToolCall(controller);
        return;
      }

      startImplicitCallIfPresent(controller);
      if (implicitCall) {
        processImplicitCall(controller);
        return;
      }

      if (buffer === before) {
        return;
      }
      stripLeadingToolCallCloseTagsFromBuffer();
      flushSafeTextPrefix(controller);
    }
  };

  const processToolCall = createQwenStreamToolCallProcessor({
    consumeCall,
    finalizeCall,
    flushSafeTextPrefix,
    getBuffer: () => buffer,
    getToolCall: () => toolCall,
    maybeEmitToolInputStart,
    setBuffer: (value) => {
      buffer = value;
    },
    setToolCall: (value) => {
      toolCall = value;
    },
    startToolCallIfPresent,
    tools,
  });

  const {
    reportUnfinishedImplicitCallAtFinish,
    reportUnfinishedToolCallAtFinish,
  } = createQwenStreamFinishReporting({ flushText, options, tools });

  const consumePendingImplicitCallAtFinish = (
    controller: StreamController
  ): void => {
    if (!implicitCall) {
      return;
    }
    const callState = implicitCall;
    const { done, remainder } = consumeCall(controller, callState, "", null);
    if (!done) {
      return;
    }
    implicitCall = null;
    implicitCallOpenTag = null;
    if (remainder.length > 0) {
      buffer = remainder + buffer;
    }
    stripLeadingToolCallCloseTagsFromBuffer();
    flushSafeTextPrefix(controller);
    drainStarts(controller);
  };

  const normalizeUnfinishedToolCall = (
    container: ToolCallContainerState
  ): void => {
    if (container.mode !== "unknown") {
      return;
    }
    container.innerBuffer = normalizeToolCallInnerOpenVariants(
      container.innerBuffer,
      tools
    );
    const callMatch = QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE.exec(
      container.innerBuffer
    );
    const signalMatch =
      QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE.exec(
        container.innerBuffer
      );
    if (callMatch && (!signalMatch || callMatch.index < signalMatch.index)) {
      container.mode = "multi";
      return;
    }
    if (!signalMatch) {
      return;
    }
    container.mode = "single";
    container.activeCall = {
      endTagName: "tool_call",
      toolCallId: generateToolCallId(),
      toolName: container.outerNameAttr,
      hasEmittedStart: false,
      partialParam: null,
      emittedInput: "",
      pendingToolInputParts: [],
      raw: container.outerOpenTag,
      args: Object.create(null) as QwenRawArguments,
      buffer: "",
    };
  };

  const finalizeTrackedToolCall = (
    controller: StreamController,
    container: ToolCallContainerState,
    callState: StreamingCallState
  ): void => {
    const result = finalizeCallAtFinish(
      controller,
      callState,
      container.outerNameAttr
    );
    if (result.ok) {
      container.emittedToolCallCount += 1;
    }
    const shouldFlushTrailingText =
      result.ok || !shouldEmitRawToolCallTextOnError(options);
    if (shouldFlushTrailingText && result.trailingText.length > 0) {
      flushRecoveredTrailingText(controller, callState, result.trailingText);
    }
    if (!result.ok && container.emittedToolCallCount === 0) {
      reportUnfinishedToolCallAtFinish(controller, container.raw, {
        toolCallId: callState.toolCallId,
        ...(callState.toolName ? { toolName: callState.toolName } : {}),
      });
    }
  };

  const reconcileUnfinishedToolCall = (
    controller: StreamController,
    container: ToolCallContainerState
  ): void => {
    normalizeUnfinishedToolCall(container);
    if (container.mode === "single" && container.activeCall) {
      container.activeCall.buffer += container.innerBuffer;
      container.innerBuffer = "";
      finalizeTrackedToolCall(controller, container, container.activeCall);
      return;
    }
    if (container.mode !== "multi") {
      reportUnfinishedToolCallAtFinish(controller, container.raw, {
        toolName: container.outerNameAttr,
      });
      return;
    }
    if (container.activeCall) {
      finalizeTrackedToolCall(controller, container, container.activeCall);
      container.activeCall = null;
      return;
    }
    if (container.emittedToolCallCount === 0) {
      reportUnfinishedToolCallAtFinish(controller, container.raw, {
        toolName: container.outerNameAttr,
      });
    }
  };

  const finishToolCall = (controller: StreamController): void => {
    if (!toolCall) {
      return;
    }
    processToolCall(controller);
    if (!toolCall) {
      return;
    }
    const unfinishedToolCall = toolCall;
    reconcileUnfinishedToolCall(controller, unfinishedToolCall);
    toolCall = null;
  };

  const finishImplicitCall = (controller: StreamController): void => {
    if (!implicitCall) {
      stripLeadingToolCallCloseTagsFromBuffer();
      flushSafeTextPrefix(controller);
      drainStarts(controller);
      return;
    }
    const callState = implicitCall;
    const openTag = implicitCallOpenTag;
    implicitCall = null;
    implicitCallOpenTag = null;

    const result = finalizeCallAtFinish(controller, callState, null);
    const shouldFlushTrailingText =
      result.ok || !shouldEmitRawToolCallTextOnError(options);
    if (shouldFlushTrailingText && result.trailingText.length > 0) {
      flushRecoveredTrailingText(controller, callState, result.trailingText);
    }
    if (!result.ok && openTag) {
      reportUnfinishedImplicitCallAtFinish(
        controller,
        callState.raw,
        callState
      );
    }
  };

  const handleFinish = (controller: StreamController): void => {
    disableScanDeferral();
    consumePendingImplicitCallAtFinish(controller);
    finishToolCall(controller);
    finishImplicitCall(controller);
    if (buffer.length > 0) {
      flushRecoveredBufferText(controller, buffer);
      buffer = "";
    }
    flushText(controller);
  };

  const handlePassthroughChunk = (
    controller: StreamController,
    chunk: LanguageModelV4StreamPart
  ) => {
    if (!toolCall && buffer) {
      flushRecoveredBufferText(controller, buffer);
      buffer = "";
    }
    controller.enqueue(chunk);
  };

  const handleTextDeltaChunk = (
    controller: StreamController,
    delta: string
  ) => {
    if (toolCall) {
      toolCall.raw += delta;
      toolCall.innerBuffer += delta;
      processToolCall(controller);
      return;
    }

    if (implicitCall) {
      const callState = implicitCall;
      const { done, remainder } = consumeCall(
        controller,
        callState,
        delta,
        null
      );
      if (!done) {
        return;
      }
      implicitCall = null;
      implicitCallOpenTag = null;
      if (remainder.length > 0) {
        buffer = remainder + buffer;
      }
      stripLeadingToolCallCloseTagsFromBuffer();
      flushSafeTextPrefix(controller);
      drainStarts(controller);
      return;
    }

    buffer += delta;
    stripLeadingToolCallCloseTagsFromBuffer();
    flushSafeTextPrefix(controller);
    drainStarts(controller);
  };

  const handleTransformChunk = (
    controller: StreamController,
    chunk: LanguageModelV4StreamPart
  ) => {
    if (chunk.type === "finish") {
      handleFinish(controller);
      controller.enqueue(chunk);
      return;
    }
    // The parser re-segments text under its own synthetic ids (tool-call
    // markup is excised), so the provider's original text-start/text-end
    // envelopes are dropped instead of producing empty duplicate blocks.
    if (chunk.type === "text-start" || chunk.type === "text-end") {
      return;
    }

    // Raw provider chunks are observational side-channel events and may be
    // interleaved before every semantic text delta. They must not flush a
    // partial `<tool_call>` / `<function>` prefix as recovered plain text.
    if (chunk.type === "raw") {
      controller.enqueue(chunk);
      return;
    }

    if (chunk.type !== "text-delta") {
      handlePassthroughChunk(controller, chunk);
      return;
    }
    const { delta } = chunk;
    if (!delta) {
      return;
    }
    handleTextDeltaChunk(controller, delta);
  };

  return new TransformStream({
    transform(chunk, controller) {
      handleTransformChunk(controller, chunk);
    },
    flush(controller) {
      handleFinish(controller);
    },
  });
}
