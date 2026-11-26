import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateToolCallId } from "../../utils/primitives/id";
import {
  createFlushTextHandler,
  extractToolNames,
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../../utils/primitives/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../../utils/security/prototype-sensitive-keys";
import { isSideChannelStreamPart } from "../../utils/streaming/side-channel-stream-part";
import {
  emitBufferedToolInputProgressDelta,
  emitFailedBufferedToolInputLifecycle,
  emitFinalizedBufferedToolInputLifecycle,
  enqueueToolInputEndAndCall,
  isPrototypeSensitiveToolCallInputError,
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../../utils/streaming/tool-input-streaming";
import {
  findEarliestToolTag,
  findPotentialPartialToolTagStart,
} from "../../utils/xml/xml-tool-tag-scanner";
import type { ParserOptions } from "../protocol-interface";
import {
  FOREIGN_TOOL_CALL_CLOSE_RE,
  type ForeignToolCallPart,
  findForeignBlockHoldStart,
  findForeignToolCallOpenStart,
  recoverGatedForeignCalls,
} from "./foreign-recovery";
import {
  buildSchemaPropNameSet,
  parseYamlContent,
  parseYamlContentForStreamProgress,
  safeYamlFailureCause,
  YAML_BLOCK_SCALAR_HEADER_RE,
} from "./parsing";
import { stripTrailingPartialCloseTag } from "./tag-finding";

interface ActiveYamlToolCall {
  emittedInput: string;
  hasEmittedStart: boolean;
  name: string;
  pendingToolInputParts: LanguageModelV4StreamPart[];
  toolCallId: string;
}

export function createYamlXmlStreamParser({
  tools,
  options,
}: {
  tools: LanguageModelV4FunctionTool[];
  options?: ParserOptions;
}): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  const toolNames = extractToolNames(tools);

  let buffer = "";
  let currentToolCall: ActiveYamlToolCall | null = null;
  let currentTextId: string | null = null;
  let hasEmittedTextStart = false;

  const flushText = createFlushTextHandler(
    () => currentTextId,
    (newId: string | null) => {
      currentTextId = newId;
    },
    () => hasEmittedTextStart,
    (value: boolean) => {
      hasEmittedTextStart = value;
    }
  );

  const reportStreamToolCallFailure = (params: {
    bufferedParts: LanguageModelV4StreamPart[];
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>;
    dropReason: string;
    endInputOnError: boolean;
    errorDetail: Record<string, unknown>;
    hideBufferedInputOnError?: boolean;
    id: string;
    message: string;
    rawToolCallText: string;
    toolName: string;
  }): void => {
    const emitRawFallback = shouldEmitRawToolCallTextOnError(options);
    emitFailedBufferedToolInputLifecycle({
      bufferedParts: params.bufferedParts,
      controller: params.controller,
      id: params.id,
      emitRawToolCallTextOnError: emitRawFallback,
      endInputOnError: params.endInputOnError,
      hideBufferedInputOnError: params.hideBufferedInputOnError,
      rawToolCallText: params.rawToolCallText,
      emitRawText: (rawText) => {
        flushText(params.controller, rawText);
      },
    });
    options?.onError?.(params.message, {
      toolCall: safeToolCallMetadataText(params.rawToolCallText),
      toolName: params.toolName,
      toolCallId: params.id,
      dropReason: params.dropReason,
      ...params.errorDetail,
    });
  };

  const emitToolInputProgress = (
    _controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    toolContent: string
  ) => {
    if (!currentToolCall || YAML_BLOCK_SCALAR_HEADER_RE.test(toolContent)) {
      return;
    }
    const toolCall = currentToolCall;
    const parsedArgs = parseYamlContentForStreamProgress(toolContent);
    if (parsedArgs === null) {
      return;
    }
    let fullInput: string;
    try {
      fullInput = stringifyToolInputWithSchema({
        toolName: toolCall.name,
        args: parsedArgs,
        tools,
      });
    } catch {
      return;
    }
    if (fullInput === "{}" && toolContent.trim().length === 0) {
      return;
    }
    emitBufferedToolInputProgressDelta({
      enqueue: (part) => {
        toolCall.pendingToolInputParts.push(part);
      },
      id: toolCall.toolCallId,
      state: toolCall,
      fullInput,
    });
  };

  const processToolCallEnd = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    toolContent: string,
    toolName: string,
    toolCallId: string
  ) => {
    const result = parseYamlContent(
      toolContent,
      buildSchemaPropNameSet(toolName, tools)
    );
    flushText(controller);
    const original = `<${toolName}>${toolContent}</${toolName}>`;
    if (result.ok) {
      let finalInput: string;
      try {
        finalInput = stringifyToolInputWithSchema({
          toolName,
          args: result.value,
          tools,
        });
      } catch (error) {
        reportStreamToolCallFailure({
          bufferedParts: currentToolCall?.pendingToolInputParts ?? [],
          controller,
          dropReason: "malformed-tool-call-body",
          endInputOnError: currentToolCall?.hasEmittedStart === true,
          errorDetail: { error: safeToolCallMetadataError(error, original) },
          hideBufferedInputOnError:
            isPrototypeSensitiveToolCallInputError(error),
          id: toolCallId,
          message: "Could not parse streaming YAML tool call",
          rawToolCallText: original,
          toolName,
        });
        return;
      }
      if (currentToolCall && currentToolCall.toolCallId === toolCallId) {
        emitFinalizedBufferedToolInputLifecycle({
          bufferedParts: currentToolCall.pendingToolInputParts,
          controller,
          id: toolCallId,
          state: currentToolCall,
          toolName,
          finalInput,
          onMismatch: options?.onError,
        });
      } else {
        enqueueToolInputEndAndCall({
          controller,
          id: toolCallId,
          toolName,
          input: finalInput,
        });
      }
      return;
    }

    reportStreamToolCallFailure({
      bufferedParts: currentToolCall?.pendingToolInputParts ?? [],
      controller,
      dropReason: "malformed-tool-call-body",
      endInputOnError: currentToolCall?.hasEmittedStart === true,
      errorDetail: { cause: safeYamlFailureCause(result.failure, original) },
      id: toolCallId,
      message: "Could not parse streaming YAML tool call",
      rawToolCallText: original,
      toolName,
    });
  };

  const finalizeUnclosedToolCall = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ) => {
    if (!currentToolCall) {
      return;
    }

    emitToolInputProgress(controller, buffer);
    const { name: toolName, toolCallId } = currentToolCall;
    const reconciledBuffer = stripTrailingPartialCloseTag(buffer, toolName);
    const result = parseYamlContent(
      reconciledBuffer,
      buildSchemaPropNameSet(toolName, tools)
    );
    flushText(controller);
    const unfinishedContent = `<${toolName}>${buffer}`;

    if (result.ok) {
      let finalInput: string;
      try {
        finalInput = stringifyToolInputWithSchema({
          toolName,
          args: result.value,
          tools,
        });
      } catch (error) {
        reportStreamToolCallFailure({
          bufferedParts: currentToolCall.pendingToolInputParts,
          controller,
          dropReason: "malformed-tool-call-body",
          endInputOnError: currentToolCall.hasEmittedStart,
          errorDetail: {
            error: safeToolCallMetadataError(error, unfinishedContent),
          },
          hideBufferedInputOnError:
            isPrototypeSensitiveToolCallInputError(error),
          id: toolCallId,
          message: "Could not complete streaming YAML tool call at finish.",
          rawToolCallText: unfinishedContent,
          toolName,
        });
        buffer = "";
        currentToolCall = null;
        return;
      }
      emitFinalizedBufferedToolInputLifecycle({
        bufferedParts: currentToolCall.pendingToolInputParts,
        controller,
        id: toolCallId,
        state: currentToolCall,
        toolName,
        finalInput,
        onMismatch: options?.onError,
      });
    } else {
      reportStreamToolCallFailure({
        bufferedParts: currentToolCall.pendingToolInputParts,
        controller,
        dropReason: "unfinished-tool-call",
        endInputOnError: currentToolCall.hasEmittedStart,
        errorDetail: {
          cause: safeYamlFailureCause(result.failure, unfinishedContent),
        },
        id: toolCallId,
        message: "Could not complete streaming YAML tool call at finish.",
        rawToolCallText: unfinishedContent,
        toolName,
      });
    }

    buffer = "";
    currentToolCall = null;
  };

  const handlePendingToolCall = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    endTag: string,
    toolName: string
  ): boolean => {
    const endIdx = buffer.indexOf(endTag);
    if (endIdx === -1) {
      emitToolInputProgress(controller, buffer);
      return false;
    }

    const content = buffer.slice(0, endIdx);
    emitToolInputProgress(controller, content);
    buffer = buffer.slice(endIdx + endTag.length);
    processToolCallEnd(
      controller,
      content,
      toolName,
      currentToolCall?.toolCallId ?? generateToolCallId()
    );
    currentToolCall = null;
    return true;
  };

  const flushSafeText = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ): void => {
    if (buffer.length === 0) {
      return;
    }
    const holds = [
      findPotentialPartialToolTagStart(buffer, toolNames),
      findForeignBlockHoldStart(buffer),
    ].filter((value): value is number => value != null);
    const holdFrom = holds.length > 0 ? Math.min(...holds) : null;
    if (holdFrom == null) {
      flushText(controller, buffer);
      buffer = "";
      return;
    }
    if (holdFrom > 0) {
      flushText(controller, buffer.slice(0, holdFrom));
      buffer = buffer.slice(holdFrom);
    }
  };

  const emitSalvagedForeignCalls = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    calls: ForeignToolCallPart[]
  ): void => {
    flushText(controller);
    for (const call of calls) {
      controller.enqueue({
        type: "tool-input-start",
        id: call.toolCallId,
        toolName: call.toolName,
      });
      if (call.input.length > 0) {
        controller.enqueue({
          type: "tool-input-delta",
          id: call.toolCallId,
          delta: call.input,
        });
      }
      enqueueToolInputEndAndCall({
        controller,
        id: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
      });
    }
  };

  const flushTextBefore = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    end: number
  ): void => {
    if (end > 0) {
      flushText(controller, buffer.slice(0, end));
    }
  };

  const consumeSensitiveForeignBlock = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    block: string,
    start: number,
    end?: number
  ): boolean => {
    if (!toolCallTextHasPrototypeSensitiveKey(block)) {
      return false;
    }
    flushTextBefore(controller, start);
    buffer = end === undefined ? "" : buffer.slice(end);
    return true;
  };

  const tryConsumeForeignToolCallBlock = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ): boolean => {
    const lower = buffer.toLowerCase();
    const start = findForeignToolCallOpenStart(lower);
    if (start === -1) {
      return false;
    }
    const { index: realTagIndex } = findEarliestToolTag(buffer, toolNames);
    if (realTagIndex !== -1 && realTagIndex < start) {
      return false;
    }
    const closeMatch = FOREIGN_TOOL_CALL_CLOSE_RE.exec(lower.slice(start));
    if (!closeMatch) {
      return false;
    }
    const end = start + closeMatch.index + closeMatch[0].length;
    const block = buffer.slice(start, end);
    const calls = recoverGatedForeignCalls(block, tools);
    if (calls) {
      flushTextBefore(controller, start);
      emitSalvagedForeignCalls(controller, calls);
      buffer = buffer.slice(end);
      return true;
    }
    if (findEarliestToolTag(block.slice(1), toolNames).index !== -1) {
      return false;
    }
    if (consumeSensitiveForeignBlock(controller, block, start, end)) {
      return true;
    }
    flushText(controller, buffer.slice(0, end));
    buffer = buffer.slice(end);
    return true;
  };

  const salvageForeignBlockAtFinish = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ): void => {
    if (!buffer) {
      return;
    }
    const lower = buffer.toLowerCase();
    const start = findForeignToolCallOpenStart(lower);
    if (start === -1) {
      flushText(controller, buffer);
      buffer = "";
      return;
    }
    const block = buffer.slice(start);
    const calls = recoverGatedForeignCalls(block, tools);
    if (!calls) {
      if (consumeSensitiveForeignBlock(controller, block, start)) {
        return;
      }
      flushText(controller, buffer);
      buffer = "";
      return;
    }
    flushTextBefore(controller, start);
    emitSalvagedForeignCalls(controller, calls);
    buffer = "";
  };

  const handleNewToolTag = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    tagIndex: number,
    tagName: string,
    selfClosing: boolean,
    tagLength: number
  ): void => {
    if (tagIndex > 0) {
      flushText(controller, buffer.slice(0, tagIndex));
    }

    flushText(controller);

    if (selfClosing) {
      buffer = buffer.slice(tagIndex + tagLength);
      const toolCallId = generateToolCallId();
      currentToolCall = {
        name: tagName,
        toolCallId,
        emittedInput: "",
        hasEmittedStart: true,
        pendingToolInputParts: [],
      };
      controller.enqueue({
        type: "tool-input-start",
        id: toolCallId,
        toolName: tagName,
      });
      processToolCallEnd(controller, "", tagName, toolCallId);
      currentToolCall = null;
    } else {
      const startTag = `<${tagName}>`;
      buffer = buffer.slice(tagIndex + startTag.length);
      currentToolCall = {
        name: tagName,
        toolCallId: generateToolCallId(),
        emittedInput: "",
        hasEmittedStart: true,
        pendingToolInputParts: [],
      };
      controller.enqueue({
        type: "tool-input-start",
        id: currentToolCall.toolCallId,
        toolName: tagName,
      });
    }
  };

  const processIdleBuffer = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ): boolean => {
    if (tryConsumeForeignToolCallBlock(controller)) {
      return true;
    }

    const { index, name, selfClosing, tagLength } = findEarliestToolTag(
      buffer,
      toolNames
    );

    if (index === -1) {
      flushSafeText(controller);
      return false;
    }

    handleNewToolTag(controller, index, name, selfClosing, tagLength);
    return true;
  };

  const processBuffer = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ) => {
    while (true) {
      if (currentToolCall) {
        const toolName = currentToolCall.name;
        const endTag = `</${toolName}>`;
        if (!handlePendingToolCall(controller, endTag, toolName)) {
          break;
        }
      } else if (!processIdleBuffer(controller)) {
        break;
      }
    }
  };

  const handleFinishChunk = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ) => {
    if (currentToolCall) {
      finalizeUnclosedToolCall(controller);
    } else if (buffer) {
      salvageForeignBlockAtFinish(controller);
    }
    flushText(controller);
  };

  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.type === "finish") {
        handleFinishChunk(controller);
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
        if (!currentToolCall && buffer) {
          flushText(controller, buffer);
          buffer = "";
        }
        controller.enqueue(chunk);
        return;
      }

      const textContent = (chunk as unknown as { delta?: string }).delta ?? "";
      buffer += textContent;
      processBuffer(controller);
    },
    flush(controller) {
      if (currentToolCall) {
        finalizeUnclosedToolCall(controller);
      } else if (buffer) {
        salvageForeignBlockAtFinish(controller);
      }
      if (currentTextId && hasEmittedTextStart) {
        controller.enqueue({
          type: "text-end",
          id: currentTextId,
        });
        hasEmittedTextStart = false;
        currentTextId = null;
      }
    },
  });
}
