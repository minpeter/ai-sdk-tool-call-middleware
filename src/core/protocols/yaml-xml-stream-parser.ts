import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateToolCallId } from "../utils/id";
import { extractToolNames } from "../utils/protocol-utils";
import {
  findEarliestToolTag,
  findPotentialPartialToolTagStart,
} from "../utils/xml-tool-tag-scanner";
import type { ParserOptions } from "./protocol-interface";
import {
  createProtocolSemanticChunkTransform,
  createProtocolTextLifecycle,
} from "./protocol-stream-shared";
import { findForeignBlockHoldStart } from "./yaml-xml-foreign-recovery";
import {
  salvageForeignBlockAtFinish,
  tryConsumeForeignToolCallBlock,
} from "./yaml-xml-stream-foreign-recovery";
import {
  emitYamlToolInputProgress,
  finalizeUnclosedYamlToolCall,
  processYamlToolCallEnd,
} from "./yaml-xml-stream-lifecycle";

export function createYamlXmlStreamParser({
  tools,
  options,
}: {
  tools: LanguageModelV4FunctionTool[];
  options?: ParserOptions;
}): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  const toolNames = extractToolNames(tools);

  let buffer = "";
  let currentToolCall: {
    name: string;
    toolCallId: string;
    emittedInput: string;
    hasEmittedStart: boolean;
    pendingToolInputParts: LanguageModelV4StreamPart[];
  } | null = null;
  const textLifecycle = createProtocolTextLifecycle();
  const { flushText } = textLifecycle;

  const lifecycleState = {
    get buffer() {
      return buffer;
    },
    set buffer(value: string) {
      buffer = value;
    },
    get currentToolCall() {
      return currentToolCall;
    },
    set currentToolCall(value) {
      currentToolCall = value;
    },
  };
  const lifecycleContext = {
    flushText,
    options,
    state: lifecycleState,
    tools,
  };

  const handlePendingToolCall = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    endTag: string,
    toolName: string
  ): boolean => {
    const endIdx = buffer.indexOf(endTag);
    if (endIdx === -1) {
      emitYamlToolInputProgress(lifecycleContext, buffer);
      return false;
    }

    const content = buffer.slice(0, endIdx);
    emitYamlToolInputProgress(lifecycleContext, content);
    buffer = buffer.slice(endIdx + endTag.length);
    processYamlToolCallEnd(lifecycleContext, controller, {
      content,
      name: toolName,
      id: currentToolCall?.toolCallId ?? generateToolCallId(),
    });
    currentToolCall = null;
    return true;
  };

  const flushSafeText = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ): void => {
    if (buffer.length === 0) {
      return;
    }
    // Hold back only a genuine partial tool-tag suffix or a pending foreign
    // <tool_call block; everything else is provably plain text and streams
    // out immediately.
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

  const foreignRecoveryContext = {
    flushText,
    getBuffer: () => buffer,
    setBuffer: (value: string) => {
      buffer = value;
    },
    toolNames,
    tools,
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
      processYamlToolCallEnd(lifecycleContext, controller, {
        content: "",
        name: tagName,
        id: toolCallId,
      });
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

  /** Returns false when the buffer is exhausted and scanning should stop. */
  const processIdleBuffer = (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
  ): boolean => {
    if (tryConsumeForeignToolCallBlock(foreignRecoveryContext, controller)) {
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
      finalizeUnclosedYamlToolCall(lifecycleContext, controller);
    } else if (buffer) {
      salvageForeignBlockAtFinish(foreignRecoveryContext, controller);
    }
    flushText(controller);
  };

  return createProtocolSemanticChunkTransform({
    finish(controller) {
      handleFinishChunk(controller);
    },
    flush(controller) {
      if (currentToolCall) {
        finalizeUnclosedYamlToolCall(lifecycleContext, controller);
      } else if (buffer) {
        salvageForeignBlockAtFinish(foreignRecoveryContext, controller);
      }
      textLifecycle.close(controller);
    },
    passthrough(controller, chunk) {
      if (!currentToolCall && buffer) {
        flushText(controller, buffer);
        buffer = "";
      }
      controller.enqueue(chunk);
    },
    // Raw side-channel events must not flush a partial semantic tag.
    raw(controller, chunk) {
      controller.enqueue(chunk);
    },
    textDelta(controller, delta) {
      buffer += delta;
      processBuffer(controller);
    },
  });
}
