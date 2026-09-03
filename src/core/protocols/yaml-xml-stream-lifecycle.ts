import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import {
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import {
  emitBufferedToolInputProgressDelta,
  emitFailedBufferedToolInputLifecycle,
  emitFinalizedBufferedToolInputLifecycle,
  enqueueToolInputEndAndCall,
  isPrototypeSensitiveToolCallInputError,
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import type { ParserOptions } from "./protocol-interface";
import {
  buildSchemaPropNameSet,
  parseYamlContent,
  parseYamlContentForStreamProgress,
  safeYamlFailureCause,
  stripTrailingPartialCloseTag,
  YAML_BLOCK_SCALAR_HEADER_RE,
} from "./yaml-xml-parsing";

export interface BufferedYamlToolCall {
  emittedInput: string;
  hasEmittedStart: boolean;
  readonly name: string;
  readonly pendingToolInputParts: LanguageModelV4StreamPart[];
  readonly toolCallId: string;
}

export interface YamlXmlStreamState {
  buffer: string;
  currentToolCall: BufferedYamlToolCall | null;
}

export interface YamlXmlLifecycleContext {
  readonly flushText: (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    text?: string
  ) => void;
  readonly options?: ParserOptions;
  readonly state: YamlXmlStreamState;
  readonly tools: LanguageModelV4FunctionTool[];
}

export function emitYamlToolInputProgress(
  context: YamlXmlLifecycleContext,
  toolContent: string
): void {
  const toolCall = context.state.currentToolCall;
  if (!toolCall || YAML_BLOCK_SCALAR_HEADER_RE.test(toolContent)) {
    return;
  }
  const parsedArgs = parseYamlContentForStreamProgress(toolContent);
  if (parsedArgs === null) {
    return;
  }
  let fullInput: string;
  try {
    fullInput = stringifyToolInputWithSchema({
      toolName: toolCall.name,
      args: parsedArgs,
      tools: context.tools,
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
}

function emitYamlToolCallFailure(
  context: YamlXmlLifecycleContext,
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
  failure: {
    readonly error?: unknown;
    readonly original: string;
    readonly toolCallId: string;
    readonly toolName: string;
  }
): void {
  const toolCall = context.state.currentToolCall;
  const emitRawFallback = shouldEmitRawToolCallTextOnError(context.options);
  emitFailedBufferedToolInputLifecycle({
    bufferedParts: toolCall?.pendingToolInputParts ?? [],
    controller,
    id: failure.toolCallId,
    emitRawToolCallTextOnError: emitRawFallback,
    endInputOnError: toolCall?.hasEmittedStart === true,
    hideBufferedInputOnError:
      failure.error === undefined
        ? false
        : isPrototypeSensitiveToolCallInputError(failure.error),
    rawToolCallText: failure.original,
    emitRawText: (rawText) => {
      context.flushText(controller, rawText);
    },
  });
}

interface CompletedYamlToolCall {
  readonly content: string;
  readonly id: string;
  readonly name: string;
}

export function processYamlToolCallEnd(
  context: YamlXmlLifecycleContext,
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
  call: CompletedYamlToolCall
): void {
  const { content: toolContent, id: toolCallId, name: toolName } = call;
  const result = parseYamlContent(
    toolContent,
    buildSchemaPropNameSet(toolName, context.tools)
  );
  context.flushText(controller);
  const original = `<${toolName}>${toolContent}</${toolName}>`;
  if (!result.ok) {
    emitYamlToolCallFailure(context, controller, {
      original,
      toolName,
      toolCallId,
    });
    context.options?.onError?.("Could not parse streaming YAML tool call", {
      toolCall: safeToolCallMetadataText(original),
      toolName,
      toolCallId,
      dropReason: "malformed-tool-call-body",
      cause: safeYamlFailureCause(result.failure, original),
    });
    return;
  }
  let finalInput: string;
  try {
    finalInput = stringifyToolInputWithSchema({
      toolName,
      args: result.value,
      tools: context.tools,
    });
  } catch (error) {
    emitYamlToolCallFailure(context, controller, {
      error,
      original,
      toolName,
      toolCallId,
    });
    context.options?.onError?.("Could not parse streaming YAML tool call", {
      toolCall: safeToolCallMetadataText(original),
      toolName,
      toolCallId,
      dropReason: "malformed-tool-call-body",
      error: safeToolCallMetadataError(error, original),
    });
    return;
  }
  const toolCall = context.state.currentToolCall;
  if (toolCall?.toolCallId === toolCallId) {
    emitFinalizedBufferedToolInputLifecycle({
      bufferedParts: toolCall.pendingToolInputParts,
      controller,
      id: toolCallId,
      state: toolCall,
      toolName,
      finalInput,
      onMismatch: context.options?.onError,
    });
    return;
  }
  enqueueToolInputEndAndCall({
    controller,
    id: toolCallId,
    toolName,
    input: finalInput,
  });
}

export function finalizeUnclosedYamlToolCall(
  context: YamlXmlLifecycleContext,
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
): void {
  const toolCall = context.state.currentToolCall;
  if (!toolCall) {
    return;
  }
  emitYamlToolInputProgress(context, context.state.buffer);
  const { name: toolName, toolCallId } = toolCall;
  const content = stripTrailingPartialCloseTag(context.state.buffer, toolName);
  const result = parseYamlContent(
    content,
    buildSchemaPropNameSet(toolName, context.tools)
  );
  context.flushText(controller);
  const unfinishedContent = `<${toolName}>${context.state.buffer}`;
  if (!result.ok) {
    emitYamlToolCallFailure(context, controller, {
      original: unfinishedContent,
      toolName,
      toolCallId,
    });
    context.options?.onError?.(
      "Could not complete streaming YAML tool call at finish.",
      {
        toolCall: safeToolCallMetadataText(unfinishedContent),
        toolCallId,
        toolName,
        dropReason: "unfinished-tool-call",
        cause: safeYamlFailureCause(result.failure, unfinishedContent),
      }
    );
    context.state.buffer = "";
    context.state.currentToolCall = null;
    return;
  }
  let finalInput: string;
  try {
    finalInput = stringifyToolInputWithSchema({
      toolName,
      args: result.value,
      tools: context.tools,
    });
  } catch (error) {
    emitYamlToolCallFailure(context, controller, {
      error,
      original: unfinishedContent,
      toolName,
      toolCallId,
    });
    context.options?.onError?.(
      "Could not complete streaming YAML tool call at finish.",
      {
        toolCall: safeToolCallMetadataText(unfinishedContent),
        toolCallId,
        toolName,
        dropReason: "malformed-tool-call-body",
        error: safeToolCallMetadataError(error, unfinishedContent),
      }
    );
    context.state.buffer = "";
    context.state.currentToolCall = null;
    return;
  }
  emitFinalizedBufferedToolInputLifecycle({
    bufferedParts: toolCall.pendingToolInputParts,
    controller,
    id: toolCallId,
    state: toolCall,
    toolName,
    finalInput,
    onMismatch: context.options?.onError,
  });
  context.state.buffer = "";
  context.state.currentToolCall = null;
}
