import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider";
import { parse, stringify } from "../../rxml";
import { generateId } from "../utils/id";
import { escapeRegExp } from "../utils/regex";
import { NAME_CHAR_RE, WHITESPACE_REGEX } from "../utils/regex-constants";
import { tryRepairXmlSelfClosingRootWithBody } from "../utils/xml-root-repair";
import type { ParserOptions, TCMCoreProtocol } from "./protocol-interface";

export interface XmlProtocolOptions {
  parseOptions?: {
    repair?: boolean;
    maxReparses?: number;
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
    noChildNodes?: string[];
    [key: string]: unknown;
  };
}

type FlushTextFn = (
  controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
  text?: string
) => void;

function getToolSchema(tools: LanguageModelV3FunctionTool[], toolName: string) {
  return tools.find((t) => t.name === toolName)?.inputSchema;
}

interface ProcessToolCallParams {
  toolCall: {
    toolName: string;
    content: string;
    startIndex: number;
    endIndex: number;
  };
  tools: LanguageModelV3FunctionTool[];
  options?: ParserOptions;
  text: string;
  processedElements: LanguageModelV3Content[];
  parseOptions?: Record<string, unknown>;
}

function processToolCall(params: ProcessToolCallParams): void {
  const { toolCall, tools, options, text, processedElements, parseOptions } =
    params;
  const toolSchema = getToolSchema(tools, toolCall.toolName);

  const parseConfig = {
    ...(parseOptions ?? {}),
    onError:
      options?.onError ??
      (parseOptions as { onError?: ParserOptions["onError"] } | undefined)
        ?.onError,
  };

  try {
    const parsed = parse(toolCall.content, toolSchema, parseConfig);
    processedElements.push({
      type: "tool-call",
      toolCallId: generateId(),
      toolName: toolCall.toolName,
      input: JSON.stringify(parsed),
    });
  } catch (error) {
    const originalCallText = text.substring(
      toolCall.startIndex,
      toolCall.endIndex
    );
    options?.onError?.(
      `Could not process XML tool call: ${toolCall.toolName}`,
      { toolCall: originalCallText, error }
    );
    processedElements.push({ type: "text", text: originalCallText });
  }
}

interface HandleStreamingToolCallEndParams {
  toolContent: string;
  currentToolCall: { name: string; content?: string };
  tools: LanguageModelV3FunctionTool[];
  options?: ParserOptions;
  ctrl: TransformStreamDefaultController<LanguageModelV3StreamPart>;
  flushText: FlushTextFn;
  parseOptions?: Record<string, unknown>;
}

function handleStreamingToolCallEnd(
  params: HandleStreamingToolCallEndParams
): void {
  const {
    toolContent,
    currentToolCall,
    tools,
    options,
    ctrl,
    flushText,
    parseOptions,
  } = params;
  const toolSchema = getToolSchema(tools, currentToolCall.name);
  const parseConfig = {
    ...(parseOptions ?? {}),
    onError:
      options?.onError ??
      (parseOptions as { onError?: ParserOptions["onError"] } | undefined)
        ?.onError,
  };

  flushText(ctrl);
  try {
    const parsedResult = parse(toolContent, toolSchema, parseConfig);
    ctrl.enqueue({
      type: "tool-call",
      toolCallId: generateId(),
      toolName: currentToolCall.name,
      input: JSON.stringify(parsedResult),
    });
  } catch (error) {
    const original = `<${currentToolCall.name}>${toolContent}</${currentToolCall.name}>`;
    options?.onError?.("Could not process streaming XML tool call", {
      toolCall: original,
      error,
    });
    flushText(ctrl, original);
  }
}

function findClosingTagEndFlexible(
  text: string,
  contentStart: number,
  toolName: string
): number {
  let pos = contentStart;
  let depth = 1;

  while (pos < text.length) {
    const tok = nextTagToken(text, pos);
    if (tok.kind === "eof") {
      break;
    }
    const result = updateDepthWithToken(tok, toolName, depth);
    depth = result.depth;
    if (result.closedAt !== undefined) {
      return result.closedAt;
    }
    pos = tok.nextPos;
  }
  return -1;
}

function skipSpecialSegment(text: string, lt: number): number | null {
  const next = text[lt + 1];
  if (next === "!" || next === "?") {
    const gt = text.indexOf(">", lt + 1);
    if (gt !== -1) {
      return gt + 1;
    }
  }
  return null;
}

function consumeClosingTag(
  text: string,
  lt: number
): { matched: boolean; endPos: number } {
  const gt = text.indexOf(">", lt + 1);
  const endPos = gt === -1 ? text.length : gt + 1;
  return { matched: false, endPos };
}

function consumeOpenTag(
  text: string,
  lt: number
): { name: string; selfClosing: boolean; nextPos: number } | null {
  let p = lt + 1;
  while (p < text.length && WHITESPACE_REGEX.test(text[p])) {
    p += 1;
  }
  const nameStart = p;
  while (p < text.length && NAME_CHAR_RE.test(text.charAt(p))) {
    p += 1;
  }
  const name = text.slice(nameStart, p);
  const q = text.indexOf(">", p);
  if (q === -1) {
    return null;
  }
  let r = q - 1;
  while (r >= nameStart && WHITESPACE_REGEX.test(text[r])) {
    r -= 1;
  }
  const selfClosing = text[r] === "/";
  return { name, selfClosing, nextPos: q + 1 };
}

function updateDepthWithToken(
  tok:
    | { kind: "special"; nextPos: number }
    | { kind: "close"; name: string; nextPos: number }
    | { kind: "open"; name: string; selfClosing: boolean; nextPos: number },
  toolName: string,
  depth: number
): { depth: number; closedAt?: number } {
  if (tok.kind === "close" && tok.name === toolName) {
    const newDepth = depth - 1;
    return newDepth === 0
      ? { depth: newDepth, closedAt: tok.nextPos }
      : { depth: newDepth };
  }
  if (tok.kind === "open" && tok.name === toolName && !tok.selfClosing) {
    return { depth: depth + 1 };
  }
  return { depth };
}

function nextTagToken(
  text: string,
  fromPos: number
):
  | { kind: "eof"; nextPos: number }
  | { kind: "special"; nextPos: number }
  | { kind: "close"; name: string; nextPos: number }
  | { kind: "open"; name: string; selfClosing: boolean; nextPos: number } {
  const lt = text.indexOf("<", fromPos);
  if (lt === -1 || lt + 1 >= text.length) {
    return { kind: "eof", nextPos: text.length };
  }
  const next = text[lt + 1];
  const specialEnd = skipSpecialSegment(text, lt);
  if (specialEnd !== null) {
    return { kind: "special", nextPos: specialEnd };
  }
  if (next === "/") {
    const closing = consumeClosingTag(text, lt);
    let p = lt + 2;
    while (p < text.length && WHITESPACE_REGEX.test(text[p])) {
      p += 1;
    }
    const nameStart = p;
    while (p < text.length && NAME_CHAR_RE.test(text.charAt(p))) {
      p += 1;
    }
    const name = text.slice(nameStart, p);
    return { kind: "close", name, nextPos: closing.endPos };
  }
  const open = consumeOpenTag(text, lt);
  if (open === null) {
    return { kind: "eof", nextPos: text.length };
  }
  return {
    kind: "open",
    name: open.name,
    selfClosing: open.selfClosing,
    nextPos: open.nextPos,
  };
}

interface ToolTagMatch {
  tagStart: number;
  isSelfClosing: boolean;
  tagLength: number;
}

function findNextToolTag(
  text: string,
  searchIndex: number,
  toolName: string
): ToolTagMatch | null {
  const startTag = `<${toolName}>`;
  const openIdx = text.indexOf(startTag, searchIndex);
  const selfMatch = findSelfClosingTag(text, toolName, searchIndex);
  const selfIdx = selfMatch?.index ?? -1;
  if (openIdx === -1 && selfIdx === -1) {
    return null;
  }
  const isSelfClosing = selfIdx !== -1 && (openIdx === -1 || selfIdx < openIdx);
  return {
    tagStart: isSelfClosing ? selfIdx : openIdx,
    isSelfClosing,
    tagLength: isSelfClosing ? (selfMatch?.length ?? 0) : startTag.length,
  };
}

function findLastCloseTagStart(segment: string, toolName: string): number {
  const closeTagPattern = new RegExp(
    `</\\s*${escapeRegExp(toolName)}\\s*>`,
    "g"
  );
  let closeTagStart = -1;
  let match = closeTagPattern.exec(segment);
  while (match !== null) {
    closeTagStart = match.index;
    match = closeTagPattern.exec(segment);
  }
  if (closeTagStart === -1) {
    return segment.lastIndexOf("<");
  }
  return closeTagStart;
}

function pushSelfClosingToolCall(
  toolCalls: Array<{
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
    segment: string;
  }>,
  toolName: string,
  text: string,
  tagStart: number,
  tagLength: number
): number {
  const endIndex = tagStart + tagLength;
  toolCalls.push({
    toolName,
    startIndex: tagStart,
    endIndex,
    content: "",
    segment: text.substring(tagStart, endIndex),
  });
  return endIndex;
}

/**
 * Cache for self-closing tag regex patterns.
 * This cache grows with the number of unique tool names but is bounded
 * in practice since tools are defined at configuration time, not dynamically.
 */
const selfClosingTagCache = new Map<string, RegExp>();

function getSelfClosingTagPattern(toolName: string): RegExp {
  let pattern = selfClosingTagCache.get(toolName);
  if (!pattern) {
    pattern = new RegExp(`<\\s*${escapeRegExp(toolName)}\\s*/>`, "g");
    selfClosingTagCache.set(toolName, pattern);
  }
  return pattern;
}

function findSelfClosingTag(
  text: string,
  toolName: string,
  fromIndex: number
): { index: number; length: number } | null {
  const pattern = getSelfClosingTagPattern(toolName);
  pattern.lastIndex = fromIndex;
  const match = pattern.exec(text);
  if (!match || match.index === undefined) {
    return null;
  }
  return { index: match.index, length: match[0].length };
}

function appendOpenToolCallIfComplete(
  toolCalls: Array<{
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
    segment: string;
  }>,
  text: string,
  toolName: string,
  tagStart: number,
  startTag: string
): number {
  const contentStart = tagStart + startTag.length;
  const fullTagEnd = findClosingTagEndFlexible(text, contentStart, toolName);
  if (fullTagEnd === -1 || fullTagEnd <= contentStart) {
    return contentStart;
  }
  const segment = text.substring(tagStart, fullTagEnd);
  const closeTagStart = findLastCloseTagStart(segment, toolName);
  const inner =
    closeTagStart === -1
      ? segment.slice(startTag.length)
      : segment.slice(startTag.length, closeTagStart);
  toolCalls.push({
    toolName,
    startIndex: tagStart,
    endIndex: fullTagEnd,
    content: inner,
    segment,
  });
  return fullTagEnd;
}

function findToolCallsForName(
  text: string,
  toolName: string
): Array<{
  toolName: string;
  startIndex: number;
  endIndex: number;
  content: string;
  segment: string;
}> {
  const toolCalls: Array<{
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
    segment: string;
  }> = [];
  const startTag = `<${toolName}>`;
  let searchIndex = 0;

  while (searchIndex < text.length) {
    const match = findNextToolTag(text, searchIndex, toolName);
    if (match === null) {
      break;
    }
    if (match.isSelfClosing) {
      searchIndex = pushSelfClosingToolCall(
        toolCalls,
        toolName,
        text,
        match.tagStart,
        match.tagLength
      );
      continue;
    }
    searchIndex = appendOpenToolCallIfComplete(
      toolCalls,
      text,
      toolName,
      match.tagStart,
      startTag
    );
  }

  return toolCalls;
}

function findToolCalls(
  text: string,
  toolNames: string[]
): Array<{
  toolName: string;
  startIndex: number;
  endIndex: number;
  content: string;
  segment: string;
}> {
  const toolCalls: Array<{
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
    segment: string;
  }> = [];

  for (const toolName of toolNames) {
    const calls = findToolCallsForName(text, toolName);
    toolCalls.push(...calls);
  }

  return toolCalls.sort((a, b) => a.startIndex - b.startIndex);
}

function findLinePrefixedXmlBodyEnd(
  text: string,
  bodyStartIndex: number
): number {
  let cursor = bodyStartIndex;
  let depth = 0;
  let lastCompleteEnd = -1;

  while (cursor < text.length) {
    if (depth === 0) {
      cursor = consumeWhitespace(text, cursor);
      if (cursor >= text.length || text.charAt(cursor) !== "<") {
        break;
      }
    }

    const token = nextTagToken(text, cursor);
    if (token.kind === "eof") {
      break;
    }

    if (token.kind === "special") {
      if (depth === 0) {
        break;
      }
      cursor = token.nextPos;
      continue;
    }

    if (token.kind === "open") {
      cursor = token.nextPos;
      if (token.selfClosing) {
        if (depth === 0) {
          lastCompleteEnd = token.nextPos;
        }
      } else {
        depth += 1;
      }
      continue;
    }

    if (depth <= 0) {
      break;
    }
    depth -= 1;
    cursor = token.nextPos;
    if (depth === 0) {
      lastCompleteEnd = token.nextPos;
    }
  }

  return lastCompleteEnd;
}

function findLinePrefixedToolCall(
  text: string,
  toolNames: string[]
): {
  toolName: string;
  startIndex: number;
  endIndex: number;
  content: string;
  segment: string;
} | null {
  let best: {
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
    segment: string;
  } | null = null;

  for (const toolName of toolNames) {
    const linePattern = new RegExp(
      `(^|\\n)[\\t ]*${escapeRegExp(toolName)}[\\t ]*:?[\\t ]*(?:\\r?\\n|$)`,
      "g"
    );

    let match = linePattern.exec(text);
    while (match !== null) {
      const prefix = match[1] ?? "";
      const startIndex = match.index + prefix.length;
      const contentStart = consumeWhitespace(text, linePattern.lastIndex);
      if (contentStart >= text.length || text.charAt(contentStart) !== "<") {
        match = linePattern.exec(text);
        continue;
      }
      const contentEnd = findLinePrefixedXmlBodyEnd(text, contentStart);
      if (contentEnd === -1 || contentEnd <= contentStart) {
        match = linePattern.exec(text);
        continue;
      }
      const content = text.slice(contentStart, contentEnd);

      const candidate = {
        toolName,
        startIndex,
        endIndex: contentEnd,
        content,
        segment: text.slice(startIndex, contentEnd),
      };
      if (best === null || candidate.startIndex < best.startIndex) {
        best = candidate;
      }
      break;
    }
  }

  return best;
}

function findEarliestToolTag(
  buffer: string,
  toolNames: string[]
): { index: number; name: string; selfClosing: boolean; tagLength: number } {
  let bestIndex = -1;
  let bestName = "";
  let bestSelfClosing = false;
  let bestTagLength = 0;

  if (toolNames.length > 0) {
    for (const name of toolNames) {
      const openTag = `<${name}>`;
      const idxOpen = buffer.indexOf(openTag);
      const selfMatch = findSelfClosingTag(buffer, name, 0);
      const idxSelf = selfMatch?.index ?? -1;

      if (idxOpen !== -1 && (bestIndex === -1 || idxOpen < bestIndex)) {
        bestIndex = idxOpen;
        bestName = name;
        bestSelfClosing = false;
        bestTagLength = openTag.length;
      }
      if (idxSelf !== -1 && (bestIndex === -1 || idxSelf < bestIndex)) {
        bestIndex = idxSelf;
        bestName = name;
        bestSelfClosing = true;
        bestTagLength = selfMatch?.length ?? 0;
      }
    }
  }

  return {
    index: bestIndex,
    name: bestName,
    selfClosing: bestSelfClosing,
    tagLength: bestTagLength,
  };
}

function isOpenTagPrefix(suffix: string, toolName: string): boolean {
  return `${toolName}>`.startsWith(suffix);
}

function consumeWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && WHITESPACE_REGEX.test(text.charAt(i))) {
    i += 1;
  }
  return i;
}

function consumeToolNamePrefix(
  text: string,
  index: number,
  toolName: string
): { index: number; done: boolean; valid: boolean } {
  let i = index;
  let nameIndex = 0;

  while (i < text.length && nameIndex < toolName.length) {
    if (text.charAt(i) !== toolName.charAt(nameIndex)) {
      return { index: i, done: false, valid: false };
    }
    i += 1;
    nameIndex += 1;
  }

  return { index: i, done: nameIndex === toolName.length, valid: true };
}

/**
 * Checks if the remainder of text at index is a valid self-closing tag suffix.
 * Returns true if:
 * - text[index] is "/" and we're at the end (incomplete "/")
 * - text[index..] is "/>" at the end of the string
 */
function isSelfClosingSuffixRemainder(text: string, index: number): boolean {
  if (text.charAt(index) !== "/") {
    return false;
  }
  if (index + 1 >= text.length) {
    return true;
  }
  return index + 1 === text.length - 1 && text.charAt(index + 1) === ">";
}

function isSelfClosingTagPrefix(suffix: string, toolName: string): boolean {
  let i = consumeWhitespace(suffix, 0);
  if (i >= suffix.length) {
    return true;
  }

  const nameRemainder = suffix.slice(i);
  if (toolName.startsWith(nameRemainder)) {
    return true;
  }

  const nameResult = consumeToolNamePrefix(suffix, i, toolName);
  if (!nameResult.valid) {
    return false;
  }

  i = nameResult.index;
  if (i >= suffix.length) {
    return true;
  }
  if (!nameResult.done) {
    return false;
  }

  i = consumeWhitespace(suffix, i);
  if (i >= suffix.length) {
    return true;
  }

  return isSelfClosingSuffixRemainder(suffix, i);
}

function findPotentialToolTagStart(
  buffer: string,
  toolNames: string[]
): number {
  if (toolNames.length === 0 || buffer.length === 0) {
    return -1;
  }

  const lastGt = buffer.lastIndexOf(">");
  const offset = lastGt === -1 ? 0 : lastGt + 1;
  const trailing = buffer.slice(offset);

  for (let i = trailing.length - 1; i >= 0; i -= 1) {
    if (trailing.charAt(i) !== "<") {
      continue;
    }
    const suffix = trailing.slice(i + 1);
    for (const name of toolNames) {
      if (
        isOpenTagPrefix(suffix, name) ||
        isSelfClosingTagPrefix(suffix, name)
      ) {
        return offset + i;
      }
    }
  }

  return -1;
}

function createFlushTextHandler(
  getCurrentTextId: () => string | null,
  setCurrentTextId: (id: string | null) => void,
  getHasEmittedTextStart: () => boolean,
  setHasEmittedTextStart: (value: boolean) => void
) {
  return (
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
    text?: string
  ) => {
    const content = text;
    if (content) {
      if (!getCurrentTextId()) {
        const newId = generateId();
        setCurrentTextId(newId);
        controller.enqueue({
          type: "text-start",
          id: newId,
        });
        setHasEmittedTextStart(true);
      }
      controller.enqueue({
        type: "text-delta",
        id: getCurrentTextId() as string,
        delta: content,
      });
    }

    const currentTextId = getCurrentTextId();
    if (currentTextId && !text) {
      if (getHasEmittedTextStart()) {
        controller.enqueue({
          type: "text-end",
          id: currentTextId,
        });
        setHasEmittedTextStart(false);
      }
      setCurrentTextId(null);
    }
  };
}

interface ProcessToolCallInBufferParams {
  buffer: string;
  currentToolCall: { name: string; content: string };
  tools: LanguageModelV3FunctionTool[];
  options?: ParserOptions;
  controller: TransformStreamDefaultController<LanguageModelV3StreamPart>;
  flushText: FlushTextFn;
  setBuffer: (buffer: string) => void;
  parseOptions?: Record<string, unknown>;
}

function processToolCallInBuffer(params: ProcessToolCallInBufferParams): {
  buffer: string;
  currentToolCall: { name: string; content: string } | null;
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
  } = params;
  const endTagPattern = new RegExp(
    `</\\s*${escapeRegExp(currentToolCall.name)}\\s*>`
  );
  const endMatch = endTagPattern.exec(buffer);
  if (!endMatch || endMatch.index === undefined) {
    return { buffer, currentToolCall, shouldBreak: true };
  }

  const endIdx = endMatch.index;
  const endPos = endIdx + endMatch[0].length;
  const content = buffer.substring(0, endIdx);
  const remainder = buffer.substring(endPos);
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
  buffer: string;
  toolNames: string[];
  controller: TransformStreamDefaultController<LanguageModelV3StreamPart>;
  flushText: FlushTextFn;
  tools: LanguageModelV3FunctionTool[];
  options?: ParserOptions;
  parseOptions?: Record<string, unknown>;
  setBuffer: (buffer: string) => void;
}

function processNoToolCallInBuffer(params: ProcessNoToolCallInBufferParams): {
  buffer: string;
  currentToolCall: { name: string; content: string } | null;
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
  } = params;
  const {
    index: earliestStartTagIndex,
    name: earliestToolName,
    selfClosing,
    tagLength,
  } = findEarliestToolTag(buffer, toolNames);

  if (earliestStartTagIndex === -1) {
    const potentialStart = findPotentialToolTagStart(buffer, toolNames);
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

  flushText(controller, buffer.substring(0, earliestStartTagIndex));

  if (selfClosing) {
    const newBuffer = buffer.substring(earliestStartTagIndex + tagLength);
    setBuffer(newBuffer);
    handleStreamingToolCallEnd({
      toolContent: "",
      currentToolCall: { name: earliestToolName, content: "" },
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
  const newBuffer = buffer.substring(earliestStartTagIndex + startTag.length);
  setBuffer(newBuffer);
  return {
    buffer: newBuffer,
    currentToolCall: { name: earliestToolName, content: "" },
    shouldBreak: false,
    shouldContinue: true,
  };
}

function createProcessBufferHandler(
  getBuffer: () => string,
  setBuffer: (buffer: string) => void,
  getCurrentToolCall: () => { name: string; content: string } | null,
  setCurrentToolCall: (
    toolCall: { name: string; content: string } | null
  ) => void,
  tools: LanguageModelV3FunctionTool[],
  options: ParserOptions | undefined,
  toolNames: string[],
  flushText: FlushTextFn,
  parseOptions?: Record<string, unknown>
) {
  return (
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
  ) => {
    while (true) {
      const currentToolCall = getCurrentToolCall();
      if (currentToolCall) {
        const result = processToolCallInBuffer({
          buffer: getBuffer(),
          currentToolCall,
          tools,
          options,
          controller,
          flushText,
          setBuffer,
          parseOptions,
        });
        setBuffer(result.buffer);
        setCurrentToolCall(result.currentToolCall);
        if (result.shouldBreak) {
          break;
        }
      } else {
        const result = processNoToolCallInBuffer({
          buffer: getBuffer(),
          toolNames,
          controller,
          flushText,
          tools,
          options,
          parseOptions,
          setBuffer,
        });
        setBuffer(result.buffer);
        setCurrentToolCall(result.currentToolCall);
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

export const xmlProtocol = (
  protocolOptions?: XmlProtocolOptions
): TCMCoreProtocol => {
  const parseOptions = {
    repair: true,
    noChildNodes: [],
    ...(protocolOptions?.parseOptions ?? {}),
  };

  return {
    formatTools({ tools, toolSystemPromptTemplate }) {
      return toolSystemPromptTemplate(tools || []);
    },

    formatToolCall(toolCall: LanguageModelV3ToolCall): string {
      let args: unknown = {};
      if (toolCall.input != null) {
        try {
          args = JSON.parse(toolCall.input);
        } catch {
          args = toolCall.input;
        }
      }
      return stringify(toolCall.toolName, args, {
        suppressEmptyNode: false,
        format: true,
        minimalEscaping: true,
      });
    },

    parseGeneratedText({ text, tools, options }) {
      const toolNames = tools.map((t) => t.name).filter(Boolean) as string[];
      if (toolNames.length === 0) {
        return [{ type: "text", text }];
      }

      const processedElements: LanguageModelV3Content[] = [];
      let currentIndex = 0;
      let parseText = text;

      let toolCalls = findToolCalls(parseText, toolNames);
      if (toolCalls.length === 0) {
        const fallbackToolCall = findLinePrefixedToolCall(parseText, toolNames);
        if (fallbackToolCall !== null) {
          toolCalls.push(fallbackToolCall);
        }
      }
      if (toolCalls.length === 0) {
        const repaired = tryRepairXmlSelfClosingRootWithBody(
          parseText,
          toolNames
        );
        if (repaired) {
          const repairedCalls = findToolCalls(repaired, toolNames);
          if (repairedCalls.length > 0) {
            parseText = repaired;
            toolCalls = repairedCalls;
          }
        }
      }

      for (const tc of toolCalls) {
        if (tc.startIndex > currentIndex) {
          processedElements.push({
            type: "text",
            text: parseText.substring(currentIndex, tc.startIndex),
          });
        }
        processToolCall({
          toolCall: tc,
          tools,
          options,
          text: parseText,
          processedElements,
          parseOptions,
        });
        currentIndex = tc.endIndex;
      }

      if (currentIndex < parseText.length) {
        processedElements.push({
          type: "text",
          text: parseText.substring(currentIndex),
        });
      }

      return processedElements;
    },

    createStreamParser({ tools, options }) {
      const toolNames = tools.map((t) => t.name).filter(Boolean) as string[];
      let buffer = "";
      let currentToolCall: { name: string; content: string } | null = null;
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

      const processBuffer = createProcessBufferHandler(
        () => buffer,
        (newBuffer: string) => {
          buffer = newBuffer;
        },
        () => currentToolCall,
        (newToolCall: { name: string; content: string } | null) => {
          currentToolCall = newToolCall;
        },
        tools,
        options,
        toolNames,
        flushText,
        parseOptions
      );

      return new TransformStream({
        transform(chunk, controller) {
          if (chunk.type === "finish") {
            if (currentToolCall) {
              const unfinishedContent = `<${currentToolCall.name}>${currentToolCall.content}${buffer}`;
              flushText(controller, unfinishedContent);
              buffer = "";
              currentToolCall = null;
            } else if (buffer) {
              flushText(controller, buffer);
              buffer = "";
            }
            flushText(controller);
            controller.enqueue(chunk);
            return;
          }

          if (chunk.type !== "text-delta") {
            if (buffer) {
              flushText(controller, buffer);
              buffer = "";
            }
            controller.enqueue(chunk);
            return;
          }

          const textContent =
            (chunk as unknown as { delta?: string }).delta ?? "";
          buffer += textContent;
          processBuffer(controller);
        },
        flush(controller) {
          if (currentToolCall) {
            const unfinishedContent = `<${currentToolCall.name}>${currentToolCall.content || ""}${buffer}`;
            flushText(controller, unfinishedContent);
            buffer = "";
            currentToolCall = null;
          } else if (buffer) {
            flushText(controller, buffer);
            buffer = "";
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
    },

    extractToolCallSegments({ text, tools }) {
      const toolNames = tools.map((t) => t.name).filter(Boolean) as string[];
      if (toolNames.length === 0) {
        return [];
      }

      return findToolCalls(text, toolNames).map((tc) => tc.segment);
    },
  };
};
