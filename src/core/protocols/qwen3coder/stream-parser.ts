import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { getPotentialStartIndex } from "../../utils/primitives/get-potential-start-index";
import { generateToolCallId } from "../../utils/primitives/id";
import { createFlushTextHandler } from "../../utils/primitives/protocol-utils";
import { isSideChannelStreamPart } from "../../utils/streaming/side-channel-stream-part";
import type { ParserOptions } from "../protocol-interface";
import {
  getPotentialTagStartIndex,
  normalizeStreamToolCallInnerOpenVariants,
  QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_TOOL_CALL_CLOSE_TAG_RE,
  stripLeadingToolCallCloseTags,
  TOOL_CALL_OPEN_RE,
} from "./call-syntax";
import { getAttributeValue, getShorthandValue } from "./param-tag-primitives";
import { createQwenStreamCallConsumption } from "./stream-call-consumption";
import { createQwenStreamCallLifecycle } from "./stream-call-lifecycle";
import {
  type QwenStreamMutableState,
  reconcileQwenStreamFinish,
} from "./stream-finish-reconciliation";
import { createQwenStreamFinishReporting } from "./stream-finish-reporting";
import { createQwenStreamTextRecovery } from "./stream-text-recovery";
import type { StreamController, StreamingCallState } from "./stream-types";

export function createQwen3CoderStreamParser({
  tools,
  options,
}: {
  tools: LanguageModelV4FunctionTool[];
  options?: ParserOptions;
}): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  const toolCallStartPrefixLower = "<tool_call";
  const implicitCallPrefixesLower = ["<function", "<call", "<tool", "<invoke"];
  const standaloneParamPrefixesLower = [
    "<parameter",
    "<param",
    "<argument",
    "<arg",
  ];

  const state: QwenStreamMutableState = {
    buffer: "",
    toolCall: null,
    implicitCall: null,
    implicitCallOpenTag: null,
  };
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
        if (state.toolCall) {
          state.toolCall.emittedToolCallCount += 1;
        }
      },
      parseStreamingCallContent,
    });

  const flushSafeTextPrefix = (controller: StreamController) => {
    const lower = state.buffer.toLowerCase();

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
      if (state.buffer.length > 0) {
        flushRecoveredBufferText(controller, state.buffer);
        state.buffer = "";
      }
      return;
    }

    if (potentialIndex > 0) {
      flushText(controller, state.buffer.slice(0, potentialIndex));
      state.buffer = state.buffer.slice(potentialIndex);
    }
  };

  const stripLeadingToolCallCloseTagsFromBuffer = () => {
    if (!state.buffer) {
      return;
    }
    const stripped = stripLeadingToolCallCloseTags(state.buffer);
    if (stripped !== state.buffer) {
      state.buffer = stripped;
    }
  };

  const startToolCallIfPresent = () => {
    if (state.toolCall || state.implicitCall) {
      return;
    }

    const lower = state.buffer.toLowerCase();
    const startIndex = getPotentialStartIndex(lower, toolCallStartPrefixLower);
    if (startIndex == null || startIndex !== 0) {
      return;
    }

    const gtIndex = state.buffer.indexOf(">");
    if (gtIndex === -1) {
      return;
    }

    const openTag = state.buffer.slice(0, gtIndex + 1);
    if (!TOOL_CALL_OPEN_RE.test(openTag)) {
      return;
    }

    state.toolCall = {
      outerOpenTag: openTag,
      outerNameAttr: getAttributeValue(openTag, "name"),
      raw: openTag,
      mode: "unknown",
      innerBuffer: "",
      activeCall: null,
      emittedToolCallCount: 0,
    };

    const remainder = state.buffer.slice(gtIndex + 1);
    state.buffer = "";
    if (remainder.length > 0) {
      state.toolCall.raw += remainder;
      state.toolCall.innerBuffer += remainder;
    }
  };

  const startImplicitCallIfPresent = (controller: StreamController) => {
    if (state.toolCall || state.implicitCall) {
      return;
    }

    const match = QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE.exec(
      state.buffer
    );
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

    state.buffer = state.buffer.slice(openTag.length);

    const newCall: StreamingCallState = {
      endTagName: callTagName,
      toolCallId: generateToolCallId(),
      toolName: inlineToolName,
      hasEmittedStart: false,
      partialParam: null,
      emittedInput: "",
      pendingToolInputParts: [],
      raw: openTag,
      args: Object.create(null) as Record<string, unknown>,
      buffer: "",
    };

    maybeEmitToolInputStart(controller, newCall);

    if (selfClosing) {
      finalizeCall(controller, newCall, inlineToolName, newCall.raw);
      return;
    }

    state.implicitCall = newCall;
    state.implicitCallOpenTag = openTag;
  };

  const processImplicitCall = (controller: StreamController) => {
    while (state.implicitCall) {
      const callState = state.implicitCall;
      const { done, remainder } = consumeCall(
        controller,
        callState,
        state.buffer,
        null
      );
      state.buffer = "";
      if (!done) {
        return;
      }

      state.implicitCall = null;
      state.implicitCallOpenTag = null;
      if (remainder.length > 0) {
        state.buffer = remainder;
      }

      stripLeadingToolCallCloseTagsFromBuffer();
      flushSafeTextPrefix(controller);
      startToolCallIfPresent();
      if (state.toolCall) {
        processToolCall(controller);
        return;
      }
      startImplicitCallIfPresent(controller);
    }
  };

  const drainStarts = (controller: StreamController) => {
    while (true) {
      if (state.toolCall || state.implicitCall) {
        return;
      }

      const before = state.buffer;
      startToolCallIfPresent();
      if (state.toolCall) {
        processToolCall(controller);
        return;
      }

      startImplicitCallIfPresent(controller);
      if (state.implicitCall) {
        processImplicitCall(controller);
        return;
      }

      if (state.buffer === before) {
        return;
      }
      stripLeadingToolCallCloseTagsFromBuffer();
      flushSafeTextPrefix(controller);
    }
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Stream tool-call parsing is a nested state machine.
  const processToolCall = (controller: StreamController) => {
    while (state.toolCall) {
      const { toolCall } = state;
      if (toolCall.mode === "unknown") {
        const normalization = normalizeStreamToolCallInnerOpenVariants(
          toolCall.innerBuffer,
          tools
        );
        if (normalization.status === "incomplete") {
          return;
        }
        if (normalization.status === "rewritten") {
          toolCall.innerBuffer = normalization.value;
        }
        const callMatch = QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE.exec(
          toolCall.innerBuffer
        );
        const signalMatch =
          QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE.exec(
            toolCall.innerBuffer
          );
        if (
          callMatch &&
          (!signalMatch || (callMatch.index ?? 0) < (signalMatch.index ?? 0))
        ) {
          toolCall.mode = "multi";
        } else if (signalMatch) {
          toolCall.mode = "single";
          const activeCall: StreamingCallState = {
            endTagName: "tool_call",
            toolCallId: generateToolCallId(),
            toolName: toolCall.outerNameAttr,
            hasEmittedStart: false,
            partialParam: null,
            emittedInput: "",
            pendingToolInputParts: [],
            raw: toolCall.outerOpenTag,
            args: Object.create(null) as Record<string, unknown>,
            buffer: "",
          };
          toolCall.activeCall = activeCall;
          if (toolCall.outerNameAttr) {
            maybeEmitToolInputStart(controller, activeCall);
          }
        } else {
          return;
        }
      }

      if (toolCall.mode === "single") {
        const callState = toolCall.activeCall;
        if (!callState) {
          return;
        }

        const { done, remainder } = consumeCall(
          controller,
          callState,
          toolCall.innerBuffer,
          toolCall.outerNameAttr
        );
        toolCall.innerBuffer = "";

        if (!done) {
          return;
        }

        state.toolCall = null;
        if (remainder.length > 0) {
          state.buffer = remainder + state.buffer;
        }
        flushSafeTextPrefix(controller);
        startToolCallIfPresent();
        continue;
      }

      if (toolCall.mode === "multi") {
        if (toolCall.activeCall) {
          const callState = toolCall.activeCall;
          const { done, remainder } = consumeCall(
            controller,
            callState,
            toolCall.innerBuffer,
            toolCall.outerNameAttr
          );
          toolCall.innerBuffer = "";

          if (!done) {
            return;
          }

          toolCall.activeCall = null;
          toolCall.innerBuffer = remainder;
          continue;
        }

        const closeMatch =
          QWEN3CODER_TOOL_PARSER_STREAM_TOOL_CALL_CLOSE_TAG_RE.exec(
            toolCall.innerBuffer
          );
        const callOpenMatch =
          QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE.exec(
            toolCall.innerBuffer
          );

        if (!(closeMatch || callOpenMatch)) {
          return;
        }

        const closeIndex = closeMatch?.index ?? -1;
        const callIndex = callOpenMatch?.index ?? -1;
        const hasClose = closeIndex !== -1;
        const hasCall = callIndex !== -1;

        const chooseClose = hasClose && (!hasCall || closeIndex < callIndex);
        const nextIndex = chooseClose ? closeIndex : callIndex;
        if (nextIndex > 0) {
          toolCall.innerBuffer = toolCall.innerBuffer.slice(nextIndex);
        }

        if (chooseClose) {
          const matchLen = closeMatch?.[0]?.length ?? 0;
          const remainder = toolCall.innerBuffer.slice(matchLen);
          state.toolCall = null;
          if (remainder.length > 0) {
            state.buffer = remainder + state.buffer;
          }
          flushSafeTextPrefix(controller);
          startToolCallIfPresent();
          continue;
        }

        if (!callOpenMatch) {
          return;
        }

        const openTag = callOpenMatch[0] ?? "";
        const callTagName = (callOpenMatch[1] ?? "").toLowerCase();
        const rest = toolCall.innerBuffer.slice(openTag.length);

        const selfClosing =
          QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE.test(openTag);
        if (selfClosing) {
          const toolNameAttr =
            getAttributeValue(openTag, "name") ??
            getShorthandValue(openTag) ??
            toolCall.outerNameAttr;
          const immediateCall: StreamingCallState = {
            endTagName: callTagName,
            toolCallId: generateToolCallId(),
            toolName: toolNameAttr,
            hasEmittedStart: false,
            partialParam: null,
            emittedInput: "",
            pendingToolInputParts: [],
            raw: openTag,
            args: Object.create(null) as Record<string, unknown>,
            buffer: "",
          };
          const ok = finalizeCall(
            controller,
            immediateCall,
            toolNameAttr,
            immediateCall.raw
          );
          if (ok) {
            toolCall.emittedToolCallCount += 1;
          }
          toolCall.innerBuffer = rest;
          continue;
        }

        const toolNameAttr =
          getAttributeValue(openTag, "name") ?? getShorthandValue(openTag);
        const newCall: StreamingCallState = {
          endTagName: callTagName,
          toolCallId: generateToolCallId(),
          toolName: toolNameAttr,
          hasEmittedStart: false,
          partialParam: null,
          emittedInput: "",
          pendingToolInputParts: [],
          raw: openTag,
          args: Object.create(null) as Record<string, unknown>,
          buffer: "",
        };

        if (toolNameAttr) {
          maybeEmitToolInputStart(controller, newCall);
        }

        toolCall.activeCall = newCall;
        toolCall.innerBuffer = rest;
      }
    }
  };

  const {
    reportUnfinishedImplicitCallAtFinish,
    reportUnfinishedToolCallAtFinish,
  } = createQwenStreamFinishReporting({ flushText, options, tools });

  const handleFinish = (controller: StreamController) => {
    reconcileQwenStreamFinish(controller, state, {
      consumeCall,
      disableScanDeferral,
      drainStarts,
      finalizeCallAtFinish,
      flushRecoveredBufferText,
      flushRecoveredTrailingText,
      flushSafeTextPrefix,
      flushText,
      options,
      processToolCall,
      reportUnfinishedImplicitCallAtFinish,
      reportUnfinishedToolCallAtFinish,
      stripLeadingToolCallCloseTagsFromBuffer,
      tools,
    });
  };

  const handlePassthroughChunk = (
    controller: StreamController,
    chunk: LanguageModelV4StreamPart
  ) => {
    if (!state.toolCall && state.buffer) {
      flushRecoveredBufferText(controller, state.buffer);
      state.buffer = "";
    }
    controller.enqueue(chunk);
  };

  const handleTextDeltaChunk = (
    controller: StreamController,
    delta: string
  ) => {
    if (state.toolCall) {
      state.toolCall.raw += delta;
      state.toolCall.innerBuffer += delta;
      processToolCall(controller);
      return;
    }

    if (state.implicitCall) {
      const callState = state.implicitCall;
      const { done, remainder } = consumeCall(
        controller,
        callState,
        delta,
        null
      );
      if (!done) {
        return;
      }
      state.implicitCall = null;
      state.implicitCallOpenTag = null;
      if (remainder.length > 0) {
        state.buffer = remainder + state.buffer;
      }
      stripLeadingToolCallCloseTagsFromBuffer();
      flushSafeTextPrefix(controller);
      drainStarts(controller);
      return;
    }

    state.buffer += delta;
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
    if (chunk.type === "text-start" || chunk.type === "text-end") {
      return;
    }
    if (isSideChannelStreamPart(chunk)) {
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
