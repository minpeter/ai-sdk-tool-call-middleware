import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import { enqueueCompleteToolCallLifecycle } from "../utils/tool-input-streaming";
import { findEarliestToolTag } from "../utils/xml-tool-tag-scanner";
import {
  FOREIGN_TOOL_CALL_CLOSE_RE,
  type ForeignToolCallPart,
  findForeignToolCallOpenStart,
  recoverGatedForeignCalls,
} from "./yaml-xml-foreign-recovery";

export interface ForeignRecoveryContext {
  readonly flushText: (
    controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
    text?: string
  ) => void;
  readonly getBuffer: () => string;
  readonly setBuffer: (value: string) => void;
  readonly toolNames: string[];
  readonly tools: LanguageModelV4FunctionTool[];
}

function emitSalvagedForeignCalls(
  context: ForeignRecoveryContext,
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
  calls: ForeignToolCallPart[]
): void {
  context.flushText(controller);
  for (const call of calls) {
    enqueueCompleteToolCallLifecycle({
      controller,
      call,
      emitEmptyInputDelta: true,
    });
  }
}

function flushTextBefore(
  context: ForeignRecoveryContext,
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
  end: number
): void {
  if (end > 0) {
    context.flushText(controller, context.getBuffer().slice(0, end));
  }
}

function consumeSensitiveForeignBlock(
  context: ForeignRecoveryContext,
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
  block: string,
  start: number,
  end?: number
): boolean {
  if (!toolCallTextHasPrototypeSensitiveKey(block)) {
    return false;
  }
  flushTextBefore(context, controller, start);
  context.setBuffer(end === undefined ? "" : context.getBuffer().slice(end));
  return true;
}

export function tryConsumeForeignToolCallBlock(
  context: ForeignRecoveryContext,
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
): boolean {
  const buffer = context.getBuffer();
  const lower = buffer.toLowerCase();
  const start = findForeignToolCallOpenStart(lower);
  if (start === -1) {
    return false;
  }
  const { index: realTagIndex } = findEarliestToolTag(
    buffer,
    context.toolNames
  );
  if (realTagIndex !== -1 && realTagIndex < start) {
    return false;
  }
  const closeMatch = FOREIGN_TOOL_CALL_CLOSE_RE.exec(lower.slice(start));
  if (!closeMatch) {
    return false;
  }
  const end = start + closeMatch.index + closeMatch[0].length;
  const block = buffer.slice(start, end);
  const calls = recoverGatedForeignCalls(block, context.tools);
  if (calls) {
    flushTextBefore(context, controller, start);
    emitSalvagedForeignCalls(context, controller, calls);
    context.setBuffer(buffer.slice(end));
    return true;
  }
  if (findEarliestToolTag(block.slice(1), context.toolNames).index !== -1) {
    return false;
  }
  if (consumeSensitiveForeignBlock(context, controller, block, start, end)) {
    return true;
  }
  context.flushText(controller, buffer.slice(0, end));
  context.setBuffer(buffer.slice(end));
  return true;
}

export function salvageForeignBlockAtFinish(
  context: ForeignRecoveryContext,
  controller: TransformStreamDefaultController<LanguageModelV4StreamPart>
): void {
  const buffer = context.getBuffer();
  if (!buffer) {
    return;
  }
  const start = findForeignToolCallOpenStart(buffer.toLowerCase());
  if (start === -1) {
    context.flushText(controller, buffer);
    context.setBuffer("");
    return;
  }
  const block = buffer.slice(start);
  const calls = recoverGatedForeignCalls(block, context.tools);
  if (!calls) {
    if (consumeSensitiveForeignBlock(context, controller, block, start)) {
      return;
    }
    context.flushText(controller, buffer);
    context.setBuffer("");
    return;
  }
  flushTextBefore(context, controller, start);
  emitSalvagedForeignCalls(context, controller, calls);
  context.setBuffer("");
}
