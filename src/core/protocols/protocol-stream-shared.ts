import {
  isJSONObject,
  type LanguageModelV4FunctionTool,
  type LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { RxmlValue } from "../../rxml/builders/stringify";
import { createFlushTextHandler } from "../utils/protocol-utils";
import type { EmittedToolInputState } from "../utils/streamed-tool-input-delta";
import {
  emitFailedBufferedToolInputLifecycle,
  emitFinalizedBufferedToolInputLifecycle,
  isPrototypeSensitiveToolCallInputError,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import type { ParserOptions } from "./protocol-interface";

export type ProtocolStreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;
export type ProtocolFlushText = (
  controller: ProtocolStreamController,
  text?: string
) => void;

type FinishPart = Extract<LanguageModelV4StreamPart, { type: "finish" }>;
type PassthroughPart = Exclude<
  LanguageModelV4StreamPart,
  { type: "finish" | "text-delta" | "text-end" | "text-start" }
>;

export interface ProtocolSemanticChunkHandlers {
  readonly finish: (
    controller: ProtocolStreamController,
    chunk: FinishPart
  ) => void;
  readonly flush: (controller: ProtocolStreamController) => void;
  readonly passthrough: (
    controller: ProtocolStreamController,
    chunk: PassthroughPart
  ) => void;
  readonly raw?: (
    controller: ProtocolStreamController,
    chunk: Extract<LanguageModelV4StreamPart, { type: "raw" }>
  ) => void;
  readonly textDelta: (
    controller: ProtocolStreamController,
    delta: string
  ) => void;
}

interface BufferedToolInputState extends EmittedToolInputState {
  readonly hasEmittedStart: boolean;
  readonly name: string;
  readonly pendingToolInputParts: LanguageModelV4StreamPart[];
  readonly toolCallId: string;
}

export interface ProtocolTextLifecycle {
  readonly close: (controller: ProtocolStreamController) => void;
  readonly flushText: ProtocolFlushText;
}

export function createProtocolTextLifecycle(): ProtocolTextLifecycle {
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
  return {
    flushText,
    close(controller) {
      if (!(currentTextId && hasEmittedTextStart)) {
        return;
      }
      controller.enqueue({ type: "text-end", id: currentTextId });
      currentTextId = null;
      hasEmittedTextStart = false;
    },
  };
}

export function finalizeBufferedToolInput(options: {
  readonly controller: ProtocolStreamController;
  readonly emitRawToolCallTextOnError: boolean;
  readonly flushText: ProtocolFlushText;
  readonly onFailure: (error: Error) => void;
  readonly onMismatch?: NonNullable<ParserOptions["onError"]>;
  readonly parseInput: () => RxmlValue;
  readonly rawToolCallText: string;
  readonly state: BufferedToolInputState;
  readonly tools: LanguageModelV4FunctionTool[];
}): void {
  const { controller, state } = options;
  options.flushText(controller);
  try {
    const args = options.parseInput();
    if (!isJSONObject(args)) {
      throw new Error("XML tool call arguments must be an object");
    }
    const finalInput = stringifyToolInputWithSchema({
      toolName: state.name,
      args,
      tools: options.tools,
    });
    emitFinalizedBufferedToolInputLifecycle({
      bufferedParts: state.pendingToolInputParts,
      controller,
      id: state.toolCallId,
      state,
      toolName: state.name,
      finalInput,
      onMismatch: options.onMismatch,
    });
  } catch (error) {
    const caughtError =
      error instanceof Error ? error : new Error(String(error));
    emitFailedBufferedToolInputLifecycle({
      bufferedParts: state.pendingToolInputParts,
      controller,
      id: state.toolCallId,
      emitRawToolCallTextOnError: options.emitRawToolCallTextOnError,
      endInputOnError: state.hasEmittedStart,
      hideBufferedInputOnError:
        isPrototypeSensitiveToolCallInputError(caughtError),
      rawToolCallText: options.rawToolCallText,
      emitRawText: (text) => {
        options.flushText(controller, text);
      },
    });
    options.onFailure(caughtError);
  }
}

export function createProtocolSemanticChunkTransform(
  handlers: ProtocolSemanticChunkHandlers
): TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart> {
  return new TransformStream({
    transform(chunk, controller) {
      if (chunk.type === "finish") {
        handlers.finish(controller, chunk);
        controller.enqueue(chunk);
        return;
      }
      // Protocol parsers re-segment semantic text under synthetic ids.
      if (chunk.type === "text-start" || chunk.type === "text-end") {
        return;
      }
      if (chunk.type === "raw" && handlers.raw) {
        handlers.raw(controller, chunk);
        return;
      }
      if (chunk.type === "text-delta") {
        handlers.textDelta(controller, chunk.delta ?? "");
        return;
      }
      handlers.passthrough(controller, chunk);
    },
    flush(controller) {
      handlers.flush(controller);
    },
  });
}
