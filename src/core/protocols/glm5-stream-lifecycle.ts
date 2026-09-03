import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateToolCallId } from "../utils/id";
import {
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import {
  emitToolInputProgressDelta,
  enqueueToolInputEnd,
  shouldEmitRawToolCallTextOnError,
} from "../utils/tool-input-streaming";
import {
  parseGlm5CallBody,
  type ResolvedGlm5ProtocolOptions,
  stringifyGlm5CallInput,
} from "./glm5-call-parsing";
import {
  clearGlm5StreamBody,
  materializeGlm5StreamBody,
} from "./glm5-stream-body";
import {
  type ActiveGlm5Call,
  createGlm5CloseTagScanner,
  hasPotentialGlm5StructuralTagSuffix,
  materializeRawGlm5Call,
} from "./glm5-stream-close-scanner";
import { createGlm5CallFinalizer } from "./glm5-stream-finalization";
import type { ParserOptions } from "./protocol-interface";

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;

interface Glm5StreamLifecycleOptions {
  bodyLengthLimit: number;
  flushText: (controller: StreamController, text?: string) => void;
  onStreamPoisoned: () => void;
  options?: ParserOptions;
  protocolOptions: ResolvedGlm5ProtocolOptions;
  tools: LanguageModelV4FunctionTool[];
}

export interface Glm5StreamLifecycle {
  closeToolInput: (controller: StreamController, call: ActiveGlm5Call) => void;
  emitRawFallback: (controller: StreamController, raw: string) => void;
  finalizeCall: (
    controller: StreamController,
    call: ActiveGlm5Call,
    closeTag: string,
    incomplete: boolean
  ) => void;
  markCallFailed: (
    controller: StreamController,
    call: ActiveGlm5Call,
    raw: string,
    error?: Error
  ) => void;
  markCallOversized: (
    controller: StreamController,
    call: ActiveGlm5Call
  ) => void;
  updateToolInputProgress: (
    controller: StreamController,
    call: ActiveGlm5Call
  ) => void;
}

const OVERSIZED_GLM5_TOOL_CALL_METADATA =
  "[oversized GLM-5.2 tool call omitted]";

export function createGlm5StreamLifecycle({
  bodyLengthLimit,
  flushText,
  onStreamPoisoned,
  options,
  protocolOptions,
  tools,
}: Glm5StreamLifecycleOptions): Glm5StreamLifecycle {
  const emitRawFallback = (controller: StreamController, raw: string) => {
    if (
      shouldEmitRawToolCallTextOnError(options) &&
      !toolCallTextHasPrototypeSensitiveKey(raw)
    ) {
      flushText(controller, raw);
    }
  };

  const reportFailure = (raw: string, call: ActiveGlm5Call, error?: Error) => {
    options?.onError?.("Could not parse streaming GLM-5.2 tool call.", {
      dropReason: "malformed-glm5-tool-call",
      ...(error === undefined
        ? {}
        : { error: safeToolCallMetadataError(error, raw) }),
      toolCall: safeToolCallMetadataText(raw),
      toolCallId: call.id ?? undefined,
      toolName: call.toolName ?? undefined,
    });
  };

  const ensureToolInputStarted = (
    controller: StreamController,
    call: ActiveGlm5Call,
    toolName: string
  ) => {
    if (call.id || call.failed) {
      return;
    }
    flushText(controller);
    call.id = generateToolCallId();
    call.toolName = toolName;
    controller.enqueue({
      type: "tool-input-start",
      id: call.id,
      toolName,
    });
  };

  const closeToolInput = (
    controller: StreamController,
    call: ActiveGlm5Call
  ) => {
    if (!(call.id && !call.inputEnded)) {
      return;
    }
    enqueueToolInputEnd({ controller, id: call.id });
    call.inputEnded = true;
  };

  const markCallFailed = (
    controller: StreamController,
    call: ActiveGlm5Call,
    raw: string,
    error?: Error
  ) => {
    if (!call.failed) {
      reportFailure(raw, call, error);
      call.failed = true;
    }
    closeToolInput(controller, call);
  };

  const markCallOversized = (
    controller: StreamController,
    call: ActiveGlm5Call
  ) => {
    if (!call.failed) {
      options?.onError?.("Could not parse streaming GLM-5.2 tool call.", {
        bodyLengthLimit,
        dropReason: "malformed-glm5-tool-call",
        toolCall: OVERSIZED_GLM5_TOOL_CALL_METADATA,
        toolCallId: call.id ?? undefined,
        toolName: call.toolName ?? undefined,
      });
      call.failed = true;
    }
    closeToolInput(controller, call);

    // An oversized argument can contain arbitrary literal close markers. Once
    // the hard limit is crossed there is no safe structural boundary at which
    // to resume, so poison the remainder of this model stream. Drop all large
    // retained strings immediately and never reconstruct a raw fallback.
    clearGlm5StreamBody(call.body);
    call.closeScanner = createGlm5CloseTagScanner();
    call.emittedInput = "";
    call.openTag = "";
    call.oversized = true;
    call.suppressRemainderResync = true;
    onStreamPoisoned();
  };

  const shouldSkipProgress = (call: ActiveGlm5Call) =>
    call.failed ||
    call.markdownCodePrefixed ||
    call.closeScanner.firstClose ||
    call.body.length < call.nextProgressParseLength;

  const tryParseProgressSnapshot = (
    controller: StreamController,
    call: ActiveGlm5Call,
    materializedBody: string
  ): ReturnType<typeof parseGlm5CallBody> => {
    try {
      return parseGlm5CallBody({
        body: materializedBody,
        complete: false,
        protocolOptions,
        tools,
      });
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      markCallFailed(controller, call, materializeRawGlm5Call(call), error);
      return null;
    }
  };

  const tryEmitProgressSnapshot = (
    controller: StreamController,
    call: ActiveGlm5Call,
    id: string,
    snapshot: NonNullable<ReturnType<typeof parseGlm5CallBody>>
  ) => {
    try {
      const fullInput = stringifyGlm5CallInput(snapshot, tools);
      emitToolInputProgressDelta({
        controller,
        fullInput,
        id,
        state: call,
      });
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      markCallFailed(controller, call, materializeRawGlm5Call(call), error);
    }
  };

  const updateToolInputProgress = (
    controller: StreamController,
    call: ActiveGlm5Call
  ) => {
    if (shouldSkipProgress(call)) {
      return;
    }
    call.nextProgressParseLength =
      call.body.length === 0 ? 1 : call.body.length * 2;
    const materializedBody = materializeGlm5StreamBody(call.body);
    if (hasPotentialGlm5StructuralTagSuffix(materializedBody)) {
      return;
    }

    const snapshot = tryParseProgressSnapshot(
      controller,
      call,
      materializedBody
    );
    if (!snapshot) {
      return;
    }
    ensureToolInputStarted(controller, call, snapshot.toolName);
    if (!(call.id && call.toolName === snapshot.toolName)) {
      return;
    }
    tryEmitProgressSnapshot(controller, call, call.id, snapshot);
  };

  const finalizeCall = createGlm5CallFinalizer({
    closeToolInput,
    emitRawFallback,
    ensureToolInputStarted,
    flushText,
    markCallFailed,
    options,
    protocolOptions,
    tools,
  });

  return {
    closeToolInput,
    emitRawFallback,
    finalizeCall,
    markCallFailed,
    markCallOversized,
    updateToolInputProgress,
  };
}
