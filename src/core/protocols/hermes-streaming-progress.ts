import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateToolCallId } from "../utils/id";
import { emitToolInputProgressDelta } from "../utils/tool-input-streaming";
import {
  collectPreviousSignificantChars,
  consumeExistingJsonString,
  consumeJsonObjectDepth,
  isUnquotedRjsonKeyStart,
  type JsonDepthScanState,
  parseQuotedObjectKey,
  parseUnquotedObjectKey,
  readStrictJsonPropertyCandidate,
  skipJsonComment,
  skipJsonWhitespace,
} from "./hermes-json-object-key-scanner";
import {
  consumeJsonQuotedScanChar,
  findQuotedKeyEnd,
  type JsonQuotedScanState,
} from "./hermes-json-significant-char-index";
import type {
  ParserOptions,
  ProtocolToolCallResolver,
} from "./protocol-interface";

export interface StreamState {
  activeToolInput: {
    id: string;
    toolName: string;
    emittedInput: string;
  } | null;
  buffer: string;
  currentTextId: string | null;
  currentToolCallJson: string;
  /**
   * True while chunks were accumulated into `buffer` without running the
   * boundary scan (see toolCallScanDeferUntilLength). A catch-up scan must
   * run before finish reconciliation so deferred close tags are observed.
   */
  hasDeferredToolCallScan: boolean;
  hasEmittedTextStart: boolean;
  isInsideToolCall: boolean;
  pendingToolInputProgressVersion: number;
  /**
   * Tail of the already-buffered content used to detect boundary tags that
   * span deferred chunks (at most max(tag length) - 1 chars).
   */
  toolCallScanCarry: string;
  /**
   * Amortizes full rescans of the accumulated tool-call JSON. While inside a
   * tool call, every chunk used to rescan `currentToolCallJson + buffer`
   * from position 0 (RJSON-aware boundary scan) plus recompute streaming
   * progress — O(total) per chunk and quadratic overall. Once the combined
   * length exceeds a threshold, scans only run after ~1/8 growth; geometric
   * spacing keeps total scan work linear. Null when no scan has happened yet.
   */
  toolCallScanDeferUntilLength: number | null;
}

export type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;

export interface TagProcessingContext {
  controller: StreamController;
  options?: ParserOptions;
  resolveToolCall: ProtocolToolCallResolver;
  state: StreamState;
  toolCallEnd: string;
  toolCallStart: string;
  tools: LanguageModelV4FunctionTool[];
}

const JSON_PRIMITIVE_END_RE = /[,\s}]/;

interface RelaxedPropertyScanState extends JsonQuotedScanState {
  depth: number;
}

function readRelaxedPropertyValueStart(
  text: string,
  index: number,
  property: string,
  previousSignificant: string
): { nextIndex: number; valueStart?: number } | null | undefined {
  const char = text.charAt(index);
  if (
    char !== '"' &&
    char !== "'" &&
    !(isUnquotedRjsonKeyStart(char) && ["{", ","].includes(previousSignificant))
  ) {
    return;
  }
  const parsedKey =
    char === '"' || char === "'"
      ? parseQuotedObjectKey(text, index)
      : parseUnquotedObjectKey(text, index);
  if (parsedKey === null) {
    return null;
  }
  let valueStart = skipJsonWhitespace(text, parsedKey.end + 1);
  if (valueStart >= text.length || text.charAt(valueStart) !== ":") {
    return { nextIndex: parsedKey.end };
  }
  valueStart = skipJsonWhitespace(text, valueStart + 1);
  return parsedKey.key === property
    ? { nextIndex: valueStart - 1, valueStart }
    : { nextIndex: valueStart - 1 };
}

function consumeRelaxedPropertyStructure(
  state: RelaxedPropertyScanState,
  char: string
): boolean {
  if (char === "{" || char === "}") {
    state.depth = Math.max(0, state.depth + (char === "{" ? 1 : -1));
    return true;
  }
  if (state.depth === 1) {
    return false;
  }
  if (char === '"' || char === "'") {
    state.quoteChar = char;
  }
  return true;
}

function findTopLevelPropertyValueStart(
  text: string,
  property: string
): number | null {
  const objectStart = skipJsonWhitespace(text, 0);
  if (objectStart >= text.length || text.charAt(objectStart) !== "{") {
    return null;
  }
  const state: RelaxedPropertyScanState = {
    depth: 0,
    quoteChar: null,
    escaping: false,
  };
  const previousByIndex = collectPreviousSignificantChars(text);

  for (let index = objectStart; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (consumeJsonQuotedScanChar(state, char)) {
      continue;
    }
    const commentEnd = skipJsonComment(text, index);
    if (commentEnd !== null) {
      index = commentEnd;
      continue;
    }
    if (consumeRelaxedPropertyStructure(state, char)) {
      continue;
    }
    const candidate = readRelaxedPropertyValueStart(
      text,
      index,
      property,
      previousByIndex[index] ?? ""
    );
    if (candidate === null) {
      return null;
    }
    if (candidate === undefined) {
      continue;
    }
    if (candidate.valueStart !== undefined) {
      return candidate.valueStart < text.length ? candidate.valueStart : null;
    }
    index = candidate.nextIndex;
  }
  return null;
}

export function findStrictTopLevelJsonPropertyValueStart(
  text: string,
  property: string
): number | null {
  const objectStart = skipJsonWhitespace(text, 0);
  if (objectStart >= text.length || text.charAt(objectStart) !== "{") {
    return null;
  }

  const state: JsonDepthScanState = {
    depth: 0,
    escaping: false,
    inString: false,
  };

  for (let index = objectStart; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (consumeExistingJsonString(state, char)) {
      continue;
    }
    if (consumeJsonObjectDepth(state, char)) {
      continue;
    }
    if (char !== '"') {
      continue;
    }
    if (state.depth !== 1) {
      state.inString = true;
      continue;
    }

    const candidate = readStrictJsonPropertyCandidate(text, index);
    if (candidate === null) {
      return null;
    }
    if (candidate.key === property) {
      return candidate.valueStart !== undefined &&
        candidate.valueStart < text.length
        ? candidate.valueStart
        : null;
    }
    index = candidate.nextIndex;
  }

  return null;
}

function extractJsonStringAt(
  text: string,
  valueStart: number | null
): string | undefined {
  if (valueStart == null || text.charAt(valueStart) !== '"') {
    return;
  }
  const valueEnd = findQuotedKeyEnd(text, valueStart, '"');
  return valueEnd === null ? undefined : text.slice(valueStart + 1, valueEnd);
}

function extractTopLevelStringProperty(
  text: string,
  property: string
): string | undefined {
  return extractJsonStringAt(
    text,
    findTopLevelPropertyValueStart(text, property)
  );
}

export function extractStrictTopLevelStringProperty(
  text: string,
  property: string
): string | undefined {
  return extractJsonStringAt(
    text,
    findStrictTopLevelJsonPropertyValueStart(text, property)
  );
}

interface JsonValueSlice {
  readonly complete: boolean;
  readonly text: string;
}

function extractJsonContainerSlice(
  text: string,
  valueStart: number
): JsonValueSlice {
  const stack = [text.charAt(valueStart)];
  const stringState: JsonDepthScanState = {
    depth: 0,
    inString: false,
    escaping: false,
  };
  for (let index = valueStart + 1; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (consumeExistingJsonString(stringState, char)) {
      continue;
    }
    if (char === '"') {
      stringState.inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    const open = stack.at(-1);
    if ((open === "{" && char === "}") || (open === "[" && char === "]")) {
      stack.pop();
      if (stack.length === 0) {
        return { text: text.slice(valueStart, index + 1), complete: true };
      }
    }
  }
  return { text: text.slice(valueStart), complete: false };
}

function extractJsonQuotedSlice(
  text: string,
  valueStart: number
): JsonValueSlice {
  const valueEnd = findQuotedKeyEnd(text, valueStart, '"');
  return valueEnd === null
    ? { text: text.slice(valueStart), complete: false }
    : { text: text.slice(valueStart, valueEnd + 1), complete: true };
}

function extractJsonPrimitiveSlice(
  text: string,
  valueStart: number
): JsonValueSlice {
  const relativeEnd = text.slice(valueStart).search(JSON_PRIMITIVE_END_RE);
  const valueEnd = relativeEnd === -1 ? text.length : valueStart + relativeEnd;
  return {
    text: text.slice(valueStart, valueEnd),
    complete: valueEnd < text.length,
  };
}

function extractJsonValueSlice(
  text: string,
  valueStart: number
): JsonValueSlice | null {
  if (valueStart >= text.length) {
    return null;
  }
  const first = text.charAt(valueStart);
  if (first === "{" || first === "[") {
    return extractJsonContainerSlice(text, valueStart);
  }
  return first === '"'
    ? extractJsonQuotedSlice(text, valueStart)
    : extractJsonPrimitiveSlice(text, valueStart);
}

export function extractStreamingToolCallProgress(toolCallJson: string): {
  toolName: string | undefined;
  argumentsText: string | undefined;
  argumentsComplete: boolean;
} {
  const toolName = extractTopLevelStringProperty(toolCallJson, "name");
  const argsValueStart = findTopLevelPropertyValueStart(
    toolCallJson,
    "arguments"
  );
  if (argsValueStart == null) {
    return {
      toolName,
      argumentsText: undefined,
      argumentsComplete: false,
    };
  }

  const argsSlice = extractJsonValueSlice(toolCallJson, argsValueStart);
  return {
    toolName,
    argumentsText: argsSlice?.text,
    argumentsComplete: argsSlice?.complete ?? false,
  };
}

export function ensureToolInputStart(
  state: StreamState,
  controller: StreamController,
  toolName: string
) {
  if (!state.activeToolInput) {
    const id = generateToolCallId();
    state.activeToolInput = {
      id,
      toolName,
      emittedInput: "",
    };
    controller.enqueue({
      type: "tool-input-start",
      id,
      toolName,
    } as LanguageModelV4StreamPart);
  }
}

export function emitToolInputDelta(
  state: StreamState,
  controller: StreamController,
  fullInput: string
) {
  const active = state.activeToolInput;
  if (!active) {
    return;
  }

  emitToolInputProgressDelta({
    controller,
    id: active.id,
    state: active,
    fullInput,
    mode: "full-json",
  });
}
