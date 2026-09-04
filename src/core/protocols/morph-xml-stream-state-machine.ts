import type {
  JSONObject,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { escapeRegExp } from "../utils/regex";
import { findEarliestToolTag } from "../utils/xml-tool-tag-scanner";
import type { MorphXmlProtocolOptions } from "./morph-xml-protocol";
import type { ParserOptions } from "./protocol-interface";

export interface StreamingToolCallState {
  /**
   * Cached flat join of contentParts; null when parts were appended since
   * the last join. Joining collapses contentParts to a single element so
   * repeated joins only pay for content added in between.
   */
  contentFlat: string | null;
  /** Total accumulated tool-call content length. */
  contentLength: number;
  /**
   * Accumulated tool-call content chunks. Content is kept as parts instead
   * of one growing string so per-chunk scans never force V8 to flatten a
   * rope of the whole content (an O(total) copy per chunk).
   */
  contentParts: string[];
  emittedInput: string;
  hasEmittedStart: boolean;
  lastProgressContentLength: number | null;
  lastProgressFullInput: string | null;
  lastProgressGtIndex: number | null;
  /**
   * Whether the tool-call content ends with an unterminated `<` sequence.
   * Used with lastProgressTrailingStringTag to decide when appended text can
   * be proven structurally inert (no new tag can complete without it).
   */
  lastProgressPendingOpenAngle: boolean;
  /**
   * Set when the last full progress computation resolved through the
   * trailing-unclosed-string-tag branch. While set, appended chunks without
   * tag boundary characters cannot change the progress result.
   */
  lastProgressTrailingStringTag: string | null;
  name: string;
  pendingToolInputParts: LanguageModelV4StreamPart[];
  /**
   * Suffix of the accumulated content that could still be the beginning of
   * the closing tag (`</\s*name\s*>`). Only `scanCarry + newChunk` needs to
   * be scanned per chunk; everything before it was proven closing-tag-free.
   */
  scanCarry: string;
  /**
   * Live-streaming state for the trailing unclosed string property value.
   * Set when the last full progress computation identified a strictly
   * string-typed trailing tag: the raw value accumulated so far, the args
   * object to build candidates from, the absolute offset where the value
   * body begins, and the content length at which the next progress candidate
   * is built (capped bursts keep total stringify work bounded).
   */
  streamingValue: string;
  streamingValueArgsBase: JSONObject | null;
  streamingValueBodyStart: number | null;
  streamingValueNextEmitLength: number;
  toolCallId: string;
}

/**
 * Lazily materialized view of the accumulated tool-call content. `get()`
 * joins the content parts (O(total), cached); `appendedTail`, when present,
 * covers at least the content appended since the previous progress call so
 * incremental consumers can avoid materializing the full content.
 */
export interface LazyToolContent {
  appendedTail?: string;
  get: () => string;
  length: number;
}

export function appendToolCallContent(
  state: StreamingToolCallState,
  text: string
): void {
  if (text.length === 0) {
    return;
  }
  state.contentParts.push(text);
  state.contentLength += text.length;
  state.contentFlat = null;
}

export function getToolCallContent(state: StreamingToolCallState): string {
  if (state.contentFlat === null) {
    state.contentFlat = state.contentParts.join("");
    state.contentParts = [state.contentFlat];
  }
  return state.contentFlat;
}

export interface LinePrefixedToolCall {
  content: string;
  endIndex: number;
  startIndex: number;
  toolName: string;
}

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;
type MorphXmlParseOptions = NonNullable<
  MorphXmlProtocolOptions["parseOptions"]
>;

// Module-level cache keyed by tool name, mirroring selfClosingTagCache in
// xml-tool-tag-scanner.ts. The keyspace is bounded by the set of tool names
// seen by the process, so eviction is unnecessary.
const endTagPatternCache = new Map<string, RegExp>();

function getEndTagPattern(toolName: string): RegExp {
  let pattern = endTagPatternCache.get(toolName);
  if (!pattern) {
    pattern = new RegExp(`</\\s*${escapeRegExp(toolName)}\\s*>`);
    endTagPatternCache.set(toolName, pattern);
  }
  return pattern;
}

const END_TAG_WS_RE = /\s/;

/**
 * True when `suffix` (which starts with `<`) could still grow into
 * `</\s*toolName\s*>` with future chunks. Used to compute how far the
 * closing-tag search can safely skip on the next scan.
 */
function couldBeEndTagPrefix(suffix: string, toolName: string): boolean {
  let i = 1; // suffix[0] === "<"
  if (i >= suffix.length) {
    return true;
  }
  if (suffix[i] !== "/") {
    return false;
  }
  i += 1;
  while (i < suffix.length && END_TAG_WS_RE.test(suffix[i])) {
    i += 1;
  }
  let j = 0;
  while (
    i < suffix.length &&
    j < toolName.length &&
    suffix[i] === toolName[j]
  ) {
    i += 1;
    j += 1;
  }
  if (i >= suffix.length) {
    return true; // partial (or empty) name so far
  }
  if (j < toolName.length) {
    return false; // diverged from the tool name
  }
  // Full name matched; only trailing whitespace may remain (a `>` here would
  // have completed the tag and been found by the scan).
  while (i < suffix.length && END_TAG_WS_RE.test(suffix[i])) {
    i += 1;
  }
  return i >= suffix.length;
}

/**
 * Suffix of `region` (the previous carry plus newly appended text) that
 * could still grow into the closing tag with future chunks, or "" when the
 * region tail is provably closing-tag-free. The closing-tag pattern contains
 * no `<` after its first character, so only the last `<` can begin a match
 * that completes later.
 */
function nextEndTagScanCarry(region: string, toolName: string): string {
  let lastLt = -1;
  for (let k = region.length - 1; k >= 0; k -= 1) {
    if (region.charCodeAt(k) === 60 /* `<` */) {
      lastLt = k;
      break;
    }
  }
  if (lastLt === -1) {
    return "";
  }
  const suffix = region.slice(lastLt);
  return couldBeEndTagPrefix(suffix, toolName) ? suffix : "";
}

export type FlushTextFn = (controller: StreamController, text?: string) => void;

type HandleStreamingToolCallEnd = (params: {
  ctrl: StreamController;
  currentToolCall: StreamingToolCallState;
  flushText: FlushTextFn;
  options?: ParserOptions;
  parseOptions?: MorphXmlParseOptions;
  toolContent: string;
  tools: LanguageModelV4FunctionTool[];
}) => void;

interface ProcessToolCallInBufferParams {
  buffer: string;
  controller: StreamController;
  currentToolCall: StreamingToolCallState;
  emitToolInputProgress: (
    controller: StreamController,
    currentToolCall: StreamingToolCallState,
    toolContent: LazyToolContent
  ) => void;
  flushText: FlushTextFn;
  handleStreamingToolCallEnd: HandleStreamingToolCallEnd;
  options?: ParserOptions;
  parseOptions?: MorphXmlParseOptions;
  setBuffer: (buffer: string) => void;
  tools: LanguageModelV4FunctionTool[];
}

function processToolCallInBuffer(params: ProcessToolCallInBufferParams): {
  buffer: string;
  currentToolCall: StreamingToolCallState | null;
  shouldBreak: boolean;
} {
  const {
    buffer,
    currentToolCall,
    tools,
    options,
    controller,
    flushText,
    setBuffer,
    parseOptions,
    emitToolInputProgress,
    handleStreamingToolCallEnd,
  } = params;

  // Consume the pending buffer into the content accumulator; only
  // `scanCarry + buffer` needs to be scanned for the closing tag.
  const region = currentToolCall.scanCarry + buffer;
  appendToolCallContent(currentToolCall, buffer);
  setBuffer("");

  const endTagPattern = getEndTagPattern(currentToolCall.name);
  const endMatch = endTagPattern.exec(region);
  if (!endMatch || endMatch.index === undefined) {
    currentToolCall.scanCarry = nextEndTagScanCarry(
      region,
      currentToolCall.name
    );
    emitToolInputProgress(controller, currentToolCall, {
      length: currentToolCall.contentLength,
      get: () => getToolCallContent(currentToolCall),
      appendedTail: region,
    });
    return { buffer: "", currentToolCall, shouldBreak: true };
  }

  // Translate the region-relative match back to absolute content offsets.
  const regionStart = currentToolCall.contentLength - region.length;
  const endIdx = regionStart + endMatch.index;
  const endPos = endIdx + endMatch[0].length;
  const flatContent = getToolCallContent(currentToolCall);
  const content = flatContent.slice(0, endIdx);
  emitToolInputProgress(controller, currentToolCall, {
    length: content.length,
    get: () => content,
  });
  const remainder = flatContent.slice(endPos);
  setBuffer(remainder);

  handleStreamingToolCallEnd({
    toolContent: content,
    currentToolCall,
    tools,
    options,
    ctrl: controller,
    flushText,
    parseOptions,
  });

  return {
    buffer: remainder,
    currentToolCall: null,
    shouldBreak: false,
  };
}

interface ProcessNoToolCallInBufferParams {
  allowLinePrefixedCallAtBufferEnd: boolean;
  buffer: string;
  controller: StreamController;
  emitToolInputStart: (
    controller: StreamController,
    toolName: string
  ) => StreamingToolCallState;
  findLinePrefixedToolCall: (
    buffer: string,
    toolNames: string[],
    allowAtBufferEnd: boolean
  ) => LinePrefixedToolCall | null;
  findPotentialLinePrefixedToolCallStart: (
    buffer: string,
    toolNames: string[]
  ) => number;
  findPotentialToolTagStart: (buffer: string, toolNames: string[]) => number;
  flushText: FlushTextFn;
  handleStreamingToolCallEnd: HandleStreamingToolCallEnd;
  options?: ParserOptions;
  parseOptions?: MorphXmlParseOptions;
  setBuffer: (buffer: string) => void;
  toolNames: string[];
  tools: LanguageModelV4FunctionTool[];
}

function processLinePrefixedToolCall(options: {
  buffer: string;
  controller: StreamController;
  emitToolInputStart: (
    controller: StreamController,
    toolName: string
  ) => StreamingToolCallState;
  flushText: FlushTextFn;
  handleStreamingToolCallEnd: HandleStreamingToolCallEnd;
  linePrefixedCall: LinePrefixedToolCall;
  parserOptions?: ParserOptions;
  parseOptions?: MorphXmlParseOptions;
  setBuffer: (buffer: string) => void;
  tools: LanguageModelV4FunctionTool[];
}): {
  buffer: string;
  currentToolCall: null;
  shouldBreak: false;
  shouldContinue: true;
} {
  const { linePrefixedCall } = options;
  options.flushText(
    options.controller,
    options.buffer.slice(0, linePrefixedCall.startIndex)
  );
  const newBuffer = options.buffer.slice(linePrefixedCall.endIndex);
  options.setBuffer(newBuffer);
  const currentToolCall = options.emitToolInputStart(
    options.controller,
    linePrefixedCall.toolName
  );
  options.handleStreamingToolCallEnd({
    toolContent: linePrefixedCall.content,
    currentToolCall,
    tools: options.tools,
    options: options.parserOptions,
    ctrl: options.controller,
    flushText: options.flushText,
    parseOptions: options.parseOptions,
  });
  return {
    buffer: newBuffer,
    currentToolCall: null,
    shouldBreak: false,
    shouldContinue: true,
  };
}

function processNoToolCallInBuffer(params: ProcessNoToolCallInBufferParams): {
  buffer: string;
  currentToolCall: StreamingToolCallState | null;
  shouldBreak: boolean;
  shouldContinue: boolean;
} {
  const {
    buffer,
    toolNames,
    controller,
    flushText,
    tools,
    options,
    parseOptions,
    setBuffer,
    emitToolInputStart,
    findPotentialToolTagStart,
    findLinePrefixedToolCall,
    findPotentialLinePrefixedToolCallStart,
    handleStreamingToolCallEnd,
    allowLinePrefixedCallAtBufferEnd,
  } = params;
  const {
    index: earliestStartTagIndex,
    name: earliestToolName,
    selfClosing,
    tagLength,
  } = findEarliestToolTag(buffer, toolNames);
  const linePrefixedCall = findLinePrefixedToolCall(
    buffer,
    toolNames,
    allowLinePrefixedCallAtBufferEnd
  );
  const potentialLineStart = findPotentialLinePrefixedToolCallStart(
    buffer,
    toolNames
  );
  const potentialTagStart = findPotentialToolTagStart(buffer, toolNames);
  const xmlStarts = [earliestStartTagIndex, potentialTagStart].filter(
    (start) => start >= 0
  );
  const earliestXmlStart = xmlStarts.length === 0 ? -1 : Math.min(...xmlStarts);

  if (
    linePrefixedCall &&
    (earliestStartTagIndex === -1 ||
      linePrefixedCall.startIndex < earliestStartTagIndex)
  ) {
    return processLinePrefixedToolCall({
      buffer,
      controller,
      emitToolInputStart,
      flushText,
      handleStreamingToolCallEnd,
      linePrefixedCall,
      parserOptions: options,
      parseOptions,
      setBuffer,
      tools,
    });
  }

  if (
    potentialLineStart >= 0 &&
    (earliestXmlStart === -1 || potentialLineStart < earliestXmlStart)
  ) {
    const remaining = buffer.slice(potentialLineStart);
    if (potentialLineStart > 0) {
      flushText(controller, buffer.slice(0, potentialLineStart));
      setBuffer(remaining);
    }
    return {
      buffer: remaining,
      currentToolCall: null,
      shouldBreak: true,
      shouldContinue: false,
    };
  }

  if (earliestStartTagIndex === -1) {
    const potentialStarts = [potentialTagStart, potentialLineStart].filter(
      (start) => start >= 0
    );
    const potentialStart =
      potentialStarts.length === 0 ? -1 : Math.min(...potentialStarts);
    const safeLen = Math.max(
      0,
      potentialStart === -1 ? buffer.length : potentialStart
    );
    const remaining = buffer.slice(safeLen);
    if (safeLen > 0) {
      flushText(controller, buffer.slice(0, safeLen));
      setBuffer(remaining);
    }
    return {
      buffer: remaining,
      currentToolCall: null,
      shouldBreak: true,
      shouldContinue: false,
    };
  }

  flushText(controller, buffer.slice(0, earliestStartTagIndex));

  if (selfClosing) {
    const newBuffer = buffer.slice(earliestStartTagIndex + tagLength);
    setBuffer(newBuffer);
    const currentToolCall = emitToolInputStart(controller, earliestToolName);
    handleStreamingToolCallEnd({
      toolContent: "",
      currentToolCall,
      tools,
      options,
      ctrl: controller,
      flushText,
      parseOptions,
    });
    return {
      buffer: newBuffer,
      currentToolCall: null,
      shouldBreak: false,
      shouldContinue: false,
    };
  }

  const startTag = `<${earliestToolName}>`;
  const newBuffer = buffer.slice(earliestStartTagIndex + startTag.length);
  setBuffer(newBuffer);
  return {
    buffer: newBuffer,
    currentToolCall: emitToolInputStart(controller, earliestToolName),
    shouldBreak: false,
    shouldContinue: true,
  };
}

export function createProcessBufferHandler(options: {
  getBuffer: () => string;
  setBuffer: (buffer: string) => void;
  getCurrentToolCall: () => StreamingToolCallState | null;
  setCurrentToolCall: (toolCall: StreamingToolCallState | null) => void;
  tools: LanguageModelV4FunctionTool[];
  parserOptions: ParserOptions | undefined;
  toolNames: string[];
  flushText: FlushTextFn;
  parseOptions: MorphXmlParseOptions | undefined;
  emitToolInputProgress: (
    controller: StreamController,
    currentToolCall: StreamingToolCallState,
    toolContent: LazyToolContent
  ) => void;
  emitToolInputStart: (
    controller: StreamController,
    toolName: string
  ) => StreamingToolCallState;
  findPotentialToolTagStart: (buffer: string, toolNames: string[]) => number;
  findLinePrefixedToolCall: (
    buffer: string,
    toolNames: string[],
    allowAtBufferEnd: boolean
  ) => LinePrefixedToolCall | null;
  findPotentialLinePrefixedToolCallStart: (
    buffer: string,
    toolNames: string[]
  ) => number;
  handleStreamingToolCallEnd: HandleStreamingToolCallEnd;
}): (
  controller: StreamController,
  allowLinePrefixedCallAtBufferEnd?: boolean
) => void {
  return (controller, allowLinePrefixedCallAtBufferEnd = false) => {
    while (true) {
      const currentToolCall = options.getCurrentToolCall();
      if (currentToolCall) {
        const result = processToolCallInBuffer({
          buffer: options.getBuffer(),
          currentToolCall,
          tools: options.tools,
          options: options.parserOptions,
          controller,
          flushText: options.flushText,
          setBuffer: options.setBuffer,
          parseOptions: options.parseOptions,
          emitToolInputProgress: options.emitToolInputProgress,
          handleStreamingToolCallEnd: options.handleStreamingToolCallEnd,
        });
        options.setBuffer(result.buffer);
        options.setCurrentToolCall(result.currentToolCall);
        if (result.shouldBreak) {
          break;
        }
      } else {
        const result = processNoToolCallInBuffer({
          buffer: options.getBuffer(),
          toolNames: options.toolNames,
          controller,
          flushText: options.flushText,
          tools: options.tools,
          options: options.parserOptions,
          parseOptions: options.parseOptions,
          setBuffer: options.setBuffer,
          emitToolInputStart: options.emitToolInputStart,
          findPotentialToolTagStart: options.findPotentialToolTagStart,
          findLinePrefixedToolCall: options.findLinePrefixedToolCall,
          findPotentialLinePrefixedToolCallStart:
            options.findPotentialLinePrefixedToolCallStart,
          handleStreamingToolCallEnd: options.handleStreamingToolCallEnd,
          allowLinePrefixedCallAtBufferEnd,
        });
        options.setBuffer(result.buffer);
        options.setCurrentToolCall(result.currentToolCall);
        if (result.shouldBreak) {
          break;
        }
        if (result.shouldContinue) {
          continue;
        }
        break;
      }
    }
  };
}
