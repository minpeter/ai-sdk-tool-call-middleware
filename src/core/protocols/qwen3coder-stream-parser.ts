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
  normalizeStreamToolCallInnerOpenVariants,
  normalizeToolCallInnerOpenVariants,
  QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_TOOL_CALL_CLOSE_TAG_RE,
  stripLeadingToolCallCloseTags,
  TOOL_CALL_OPEN_RE,
} from "./qwen3coder-call-syntax";
import {
  getAttributeValue,
  getShorthandValue,
} from "./qwen3coder-param-tag-parsing";
import { createQwenStreamCallConsumption } from "./qwen3coder-stream-call-consumption";
import { createQwenStreamCallLifecycle } from "./qwen3coder-stream-call-lifecycle";
import { createQwenStreamFinishReporting } from "./qwen3coder-stream-finish-reporting";
import { createQwenStreamTextRecovery } from "./qwen3coder-stream-text-recovery";
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

  const { consumeCall, finalizeCallAtFinish } = createQwenStreamCallConsumption(
    {
      finalizeCall,
      onFinalized: () => {
        if (toolCall) {
          toolCall.emittedToolCallCount += 1;
        }
      },
      parseStreamingCallContent,
    }
  );

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
    if (toolCall) {
      return;
    }

    if (implicitCall) {
      return;
    }

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
    if (toolCall || implicitCall) {
      return;
    }

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
      args: Object.create(null) as Record<string, unknown>,
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
      if (toolCall || implicitCall) {
        return;
      }

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

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Stream tool-call parsing is a nested state machine.
  const processToolCall = (controller: StreamController) => {
    while (toolCall) {
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

        toolCall = null;
        if (remainder.length > 0) {
          buffer = remainder + buffer;
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
          toolCall = null;
          if (remainder.length > 0) {
            buffer = remainder + buffer;
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

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Stream finish reconciliation is a best-effort state machine cleanup.
  const handleFinish = (controller: StreamController) => {
    if (toolCall) {
      // Process any remaining complete structures first.
      processToolCall(controller);

      if (toolCall) {
        // Best-effort reconciliation on incomplete tool-call markup at finish.
        if (toolCall.mode === "unknown") {
          // The stream is over, so force malformed-opener normalization even
          // when the live path deferred it as potentially incomplete.
          toolCall.innerBuffer = normalizeToolCallInnerOpenVariants(
            toolCall.innerBuffer,
            tools
          );
          const callMatch =
            QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE.exec(
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
            toolCall.activeCall = {
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
          }
        }

        if (toolCall.mode === "single" && toolCall.activeCall) {
          toolCall.activeCall.buffer += toolCall.innerBuffer;
          toolCall.innerBuffer = "";
          const result = finalizeCallAtFinish(
            controller,
            toolCall.activeCall,
            toolCall.outerNameAttr
          );
          if (result.ok) {
            toolCall.emittedToolCallCount += 1;
          }
          const shouldFlushTrailingText =
            result.ok || !shouldEmitRawToolCallTextOnError(options);
          if (shouldFlushTrailingText && result.trailingText.length > 0) {
            flushRecoveredTrailingText(
              controller,
              toolCall.activeCall,
              result.trailingText
            );
          }
          if (!result.ok && toolCall.emittedToolCallCount === 0) {
            reportUnfinishedToolCallAtFinish(controller, toolCall.raw, {
              toolCallId: toolCall.activeCall.toolCallId,
              ...(toolCall.activeCall.toolName
                ? { toolName: toolCall.activeCall.toolName }
                : {}),
            });
          }
        } else if (toolCall.mode === "multi") {
          if (toolCall.activeCall) {
            const result = finalizeCallAtFinish(
              controller,
              toolCall.activeCall,
              toolCall.outerNameAttr
            );
            if (result.ok) {
              toolCall.emittedToolCallCount += 1;
            }
            const shouldFlushTrailingText =
              result.ok || !shouldEmitRawToolCallTextOnError(options);
            if (shouldFlushTrailingText && result.trailingText.length > 0) {
              flushRecoveredTrailingText(
                controller,
                toolCall.activeCall,
                result.trailingText
              );
            }
            if (!result.ok && toolCall.emittedToolCallCount === 0) {
              reportUnfinishedToolCallAtFinish(controller, toolCall.raw, {
                toolCallId: toolCall.activeCall.toolCallId,
                ...(toolCall.activeCall.toolName
                  ? { toolName: toolCall.activeCall.toolName }
                  : {}),
              });
            }
            toolCall.activeCall = null;
          } else if (toolCall.emittedToolCallCount === 0) {
            reportUnfinishedToolCallAtFinish(controller, toolCall.raw, {
              toolName: toolCall.outerNameAttr,
            });
          }
        } else {
          reportUnfinishedToolCallAtFinish(controller, toolCall.raw, {
            toolName: toolCall.outerNameAttr,
          });
        }

        toolCall = null;
      }
    }

    if (implicitCall) {
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
          callState.raw || openTag + callState.buffer,
          callState
        );
      }
    } else {
      stripLeadingToolCallCloseTagsFromBuffer();
      flushSafeTextPrefix(controller);
      drainStarts(controller);
    }

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
