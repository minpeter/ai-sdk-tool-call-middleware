import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { safeToolCallMetadataText } from "../utils/protocol-utils";
import {
  emitFinalizedToolInputLifecycle,
  enqueueToolInputEndAndCall,
} from "../utils/tool-input-streaming";
import {
  parseGlm5CallBody,
  type ResolvedGlm5ProtocolOptions,
  stringifyGlm5CallInput,
} from "./glm5-call-parsing";
import { materializeGlm5StreamBody } from "./glm5-stream-body";
import {
  type ActiveGlm5Call,
  materializeRawGlm5Call,
} from "./glm5-stream-close-scanner";
import type { ParserOptions } from "./protocol-interface";

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;

type MarkCallFailed = (
  controller: StreamController,
  call: ActiveGlm5Call,
  raw: string,
  error?: Error
) => void;

interface Glm5StreamFinalizationOptions {
  closeToolInput: (controller: StreamController, call: ActiveGlm5Call) => void;
  emitRawFallback: (controller: StreamController, raw: string) => void;
  ensureToolInputStarted: (
    controller: StreamController,
    call: ActiveGlm5Call,
    toolName: string
  ) => void;
  flushText: (controller: StreamController, text?: string) => void;
  markCallFailed: MarkCallFailed;
  options?: ParserOptions;
  protocolOptions: ResolvedGlm5ProtocolOptions;
  tools: LanguageModelV4FunctionTool[];
}

export type FinalizeGlm5Call = (
  controller: StreamController,
  call: ActiveGlm5Call,
  closeTag: string,
  incomplete: boolean
) => void;

export function createGlm5CallFinalizer({
  closeToolInput,
  emitRawFallback,
  flushText,
  ensureToolInputStarted,
  markCallFailed,
  options,
  protocolOptions,
  tools,
}: Glm5StreamFinalizationOptions): FinalizeGlm5Call {
  const failExecutableCall = (
    controller: StreamController,
    call: ActiveGlm5Call,
    raw: string,
    error?: Error
  ) => {
    markCallFailed(controller, call, raw, error);
    emitRawFallback(controller, raw);
  };

  const parseFinalSnapshot = (
    controller: StreamController,
    call: ActiveGlm5Call,
    raw: string
  ): ReturnType<typeof parseGlm5CallBody> | undefined => {
    try {
      return parseGlm5CallBody({
        body: materializeGlm5StreamBody(call.body),
        complete: true,
        protocolOptions,
        tools,
      });
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      failExecutableCall(controller, call, raw, error);
    }
  };

  const reportRecoveryCodes = (
    call: ActiveGlm5Call,
    snapshot: NonNullable<ReturnType<typeof parseGlm5CallBody>>,
    incomplete: boolean,
    raw: string
  ) => {
    const recoveryCodes = [
      ...snapshot.recoveries,
      ...(incomplete ? ["recovered-missing-tool-call-close"] : []),
    ];
    if (recoveryCodes.length > 0) {
      options?.onError?.("Recovered malformed streaming GLM-5.2 tool call.", {
        recoveryCodes,
        toolCall: safeToolCallMetadataText(raw),
        toolCallId: call.id,
        toolName: snapshot.toolName,
      });
    }
  };

  const finalizeMatchedSnapshot = (
    controller: StreamController,
    call: ActiveGlm5Call,
    id: string,
    snapshot: NonNullable<ReturnType<typeof parseGlm5CallBody>>,
    incomplete: boolean,
    raw: string
  ) => {
    try {
      const finalInput = stringifyGlm5CallInput(snapshot, tools);
      if (!finalInput.startsWith(call.emittedInput)) {
        options?.onError?.(
          "Final JSON does not extend emitted tool-input prefix",
          {
            dropReason: "non-monotonic-glm5-stream-input",
            emittedLength: call.emittedInput.length,
            finalLength: finalInput.length,
            toolCallId: call.id,
            toolName: call.toolName,
          }
        );
        call.failed = true;
        closeToolInput(controller, call);
        emitRawFallback(controller, raw);
        return;
      }
      if (finalInput === call.emittedInput) {
        enqueueToolInputEndAndCall({
          controller,
          id,
          input: finalInput,
          toolName: snapshot.toolName,
        });
        call.inputEnded = true;
      } else {
        emitFinalizedToolInputLifecycle({
          controller,
          finalInput,
          id,
          state: call,
          toolName: snapshot.toolName,
        });
        call.inputEnded = true;
      }
      reportRecoveryCodes(call, snapshot, incomplete, raw);
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      failExecutableCall(controller, call, raw, error);
    }
  };

  const finalizeExecutableCall = (
    controller: StreamController,
    call: ActiveGlm5Call,
    incomplete: boolean,
    raw: string
  ) => {
    if (call.failed) {
      emitRawFallback(controller, raw);
      return;
    }

    const snapshot = parseFinalSnapshot(controller, call, raw);
    if (snapshot === undefined) {
      return;
    }
    if (!snapshot) {
      failExecutableCall(controller, call, raw);
      return;
    }
    ensureToolInputStarted(controller, call, snapshot.toolName);
    if (!(call.id && call.toolName === snapshot.toolName)) {
      failExecutableCall(controller, call, raw);
      return;
    }
    finalizeMatchedSnapshot(
      controller,
      call,
      call.id,
      snapshot,
      incomplete,
      raw
    );
  };

  return (controller, call, closeTag, incomplete) => {
    if (call.oversized) {
      return;
    }
    const raw = materializeRawGlm5Call(call, closeTag);
    if (call.markdownCodePrefixed) {
      flushText(controller, raw);
      return;
    }
    finalizeExecutableCall(controller, call, incomplete, raw);
  };
}
