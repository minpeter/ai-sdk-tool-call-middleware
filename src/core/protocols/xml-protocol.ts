import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider";
import { parse, stringify } from "../../rxml";
import { generateToolCallId } from "../utils/id";
import { createFlushTextHandler } from "../utils/protocol-utils";
import { escapeRegExp } from "../utils/regex";
import { NAME_CHAR_RE, WHITESPACE_REGEX } from "../utils/regex-constants";
import {
  emitFinalRemainder,
  emitPrefixDelta,
  toIncompleteJsonPrefix,
} from "../utils/streamed-tool-input-delta";
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

function shouldEmitRawToolCallTextOnError(options?: ParserOptions): boolean {
  return options?.emitRawToolCallTextOnError === true;
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
      toolCallId: generateToolCallId(),
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
  currentToolCall: {
    name: string;
    toolCallId: string;
    emittedInput: string;
  };
  tools: LanguageModelV3FunctionTool[];
  options?: ParserOptions;
  ctrl: TransformStreamDefaultController<LanguageModelV3StreamPart>;
  flushText: FlushTextFn;
  parseOptions?: Record<string, unknown>;
}

function parseXmlTagName(rawTagBody: string): string {
  let index = 0;
  while (
    index < rawTagBody.length &&
    WHITESPACE_REGEX.test(rawTagBody[index])
  ) {
    index += 1;
  }
  const nameStart = index;
  while (
    index < rawTagBody.length &&
    NAME_CHAR_RE.test(rawTagBody.charAt(index))
  ) {
    index += 1;
  }
  return rawTagBody.slice(nameStart, index);
}

type XmlSpecialConsumeResult =
  | { kind: "none" }
  | { kind: "incomplete" }
  | { kind: "consumed"; nextPos: number };

function consumeXmlSpecialSection(
  fragment: string,
  ltIndex: number
): XmlSpecialConsumeResult {
  if (fragment.startsWith("<!--", ltIndex)) {
    const commentEnd = fragment.indexOf("-->", ltIndex + 4);
    return commentEnd === -1
      ? { kind: "incomplete" }
      : { kind: "consumed", nextPos: commentEnd + 3 };
  }
  if (fragment.startsWith("<![CDATA[", ltIndex)) {
    const cdataEnd = fragment.indexOf("]]>", ltIndex + 9);
    return cdataEnd === -1
      ? { kind: "incomplete" }
      : { kind: "consumed", nextPos: cdataEnd + 3 };
  }
  if (fragment.startsWith("<?", ltIndex)) {
    const processingEnd = fragment.indexOf("?>", ltIndex + 2);
    return processingEnd === -1
      ? { kind: "incomplete" }
      : { kind: "consumed", nextPos: processingEnd + 2 };
  }
  if (fragment.startsWith("<!", ltIndex)) {
    const declarationEnd = fragment.indexOf(">", ltIndex + 2);
    return declarationEnd === -1
      ? { kind: "incomplete" }
      : { kind: "consumed", nextPos: declarationEnd + 1 };
  }
  return { kind: "none" };
}

type XmlTagToken =
  | { kind: "close"; name: string; nextPos: number }
  | { kind: "open"; name: string; selfClosing: boolean; nextPos: number };

function parseXmlTagToken(
  fragment: string,
  ltIndex: number
): XmlTagToken | null {
  const gtIndex = fragment.indexOf(">", ltIndex + 1);
  if (gtIndex === -1) {
    return null;
  }

  const tagBody = fragment.slice(ltIndex + 1, gtIndex).trim();
  if (tagBody.length === 0) {
    return null;
  }

  if (tagBody.startsWith("/")) {
    const closeName = parseXmlTagName(tagBody.slice(1));
    if (closeName.length === 0) {
      return null;
    }
    return { kind: "close", name: closeName, nextPos: gtIndex + 1 };
  }

  const selfClosing = tagBody.endsWith("/");
  const openBody = selfClosing ? tagBody.slice(0, -1).trimEnd() : tagBody;
  const openName = parseXmlTagName(openBody);
  if (openName.length === 0) {
    return null;
  }
  return {
    kind: "open",
    name: openName,
    selfClosing,
    nextPos: gtIndex + 1,
  };
}

function analyzeXmlFragmentForProgress(
  fragment: string
): { topLevelTagNames: string[] } | null {
  const stack: string[] = [];
  const topLevelTagNames: string[] = [];
  let position = 0;

  while (position < fragment.length) {
    const ltIndex = fragment.indexOf("<", position);
    if (ltIndex === -1) {
      break;
    }

    const special = consumeXmlSpecialSection(fragment, ltIndex);
    if (special.kind === "incomplete") {
      return null;
    }
    if (special.kind === "consumed") {
      position = special.nextPos;
      continue;
    }

    const token = parseXmlTagToken(fragment, ltIndex);
    if (token === null) {
      return null;
    }

    if (token.kind === "close") {
      const openName = stack.pop();
      if (!openName || openName !== token.name) {
        return null;
      }
      position = token.nextPos;
      continue;
    }

    if (stack.length === 0) {
      topLevelTagNames.push(token.name);
    }
    if (!token.selfClosing) {
      stack.push(token.name);
    }
    position = token.nextPos;
  }

  if (stack.length > 0) {
    return null;
  }

  return { topLevelTagNames };
}

type XmlTopLevelTextScanResult =
  | { kind: "found" }
  | { kind: "invalid" }
  | { kind: "next"; nextPos: number }
  | { kind: "done"; value: boolean };

function scanXmlFragmentTopLevelTextStep(options: {
  fragment: string;
  position: number;
  stack: string[];
}): XmlTopLevelTextScanResult {
  const { fragment, position, stack } = options;

  const ltIndex = fragment.indexOf("<", position);
  if (ltIndex === -1) {
    const trailingText = fragment.slice(position);
    return {
      kind: "done",
      value: stack.length === 0 && trailingText.trim().length > 0,
    };
  }

  const textBetweenTags = fragment.slice(position, ltIndex);
  if (stack.length === 0 && textBetweenTags.trim().length > 0) {
    return { kind: "found" };
  }

  const special = consumeXmlSpecialSection(fragment, ltIndex);
  if (special.kind === "incomplete") {
    return { kind: "invalid" };
  }
  if (special.kind === "consumed") {
    return { kind: "next", nextPos: special.nextPos };
  }

  const token = parseXmlTagToken(fragment, ltIndex);
  if (token === null) {
    return { kind: "invalid" };
  }

  if (token.kind === "close") {
    const openName = stack.pop();
    if (!openName || openName !== token.name) {
      return { kind: "invalid" };
    }
  } else if (!token.selfClosing) {
    stack.push(token.name);
  }

  return { kind: "next", nextPos: token.nextPos };
}

function hasNonWhitespaceTopLevelText(fragment: string): boolean {
  if (!fragment.includes("<")) {
    return fragment.trim().length > 0;
  }

  const stack: string[] = [];
  let position = 0;

  while (position < fragment.length) {
    const step = scanXmlFragmentTopLevelTextStep({ fragment, position, stack });
    if (step.kind === "found") {
      return true;
    }
    if (step.kind === "invalid") {
      return false;
    }
    if (step.kind === "done") {
      return step.value;
    }

    position = step.nextPos;
  }

  return false;
}

function getObjectSchemaPropertyNames(schema: unknown): Set<string> | null {
  if (!schema || typeof schema !== "object") {
    return null;
  }

  const schemaObject = schema as {
    type?: unknown;
    properties?: unknown;
  };
  const typeValue = schemaObject.type;
  if (typeValue != null) {
    const isObjectType =
      typeValue === "object" ||
      (Array.isArray(typeValue) && typeValue.includes("object"));
    if (!isObjectType) {
      return null;
    }
  }
  if (!schemaObject.properties || typeof schemaObject.properties !== "object") {
    return new Set<string>();
  }

  return new Set(
    Object.keys(schemaObject.properties as Record<string, unknown>)
  );
}

function schemaAllowsArrayType(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") {
    return false;
  }

  const schemaRecord = schema as Record<string, unknown>;
  const typeValue = schemaRecord.type;
  if (typeValue === "array") {
    return true;
  }
  if (Array.isArray(typeValue) && typeValue.includes("array")) {
    return true;
  }

  const unions = [schemaRecord.anyOf, schemaRecord.oneOf, schemaRecord.allOf];
  for (const union of unions) {
    if (!Array.isArray(union)) {
      continue;
    }
    if (union.some((entry) => schemaAllowsArrayType(entry))) {
      return true;
    }
  }

  return false;
}

function getSchemaObjectProperty(
  schema: unknown,
  propertyName: string
): unknown | null {
  if (!schema || typeof schema !== "object") {
    return null;
  }

  const schemaObject = schema as Record<string, unknown>;
  const properties = schemaObject.properties;
  if (!properties || typeof properties !== "object") {
    return null;
  }

  const property = (properties as Record<string, unknown>)[propertyName];
  if (!property) {
    return null;
  }

  return property;
}

function isStableXmlProgressCandidate(options: {
  candidate: string;
  parsed: unknown;
  toolSchema: unknown;
}): boolean {
  const { candidate, parsed, toolSchema } = options;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }

  const structure = analyzeXmlFragmentForProgress(candidate);
  if (!structure) {
    return false;
  }

  const schemaProperties = getObjectSchemaPropertyNames(toolSchema);
  if (!schemaProperties || schemaProperties.size === 0) {
    return false;
  }

  const parsedObject = parsed as Record<string, unknown>;
  const uniqueTopLevelTags = new Set(structure.topLevelTagNames);
  for (const tagName of uniqueTopLevelTags) {
    if (!schemaProperties.has(tagName)) {
      continue;
    }
    const schemaProperty = getSchemaObjectProperty(toolSchema, tagName);
    if (
      schemaProperty &&
      schemaAllowsArrayType(schemaProperty) &&
      !Array.isArray(parsedObject[tagName])
    ) {
      return false;
    }
  }

  if (structure.topLevelTagNames.length === 1) {
    const onlyTopLevelTag = structure.topLevelTagNames[0];
    if (
      !schemaProperties ||
      schemaProperties.size === 0 ||
      !schemaProperties.has(onlyTopLevelTag)
    ) {
      return false;
    }
  }

  return true;
}

function parseXmlContentForStreamProgress({
  toolContent,
  toolSchema,
  parseOptions,
}: {
  toolContent: string;
  toolSchema: unknown;
  parseOptions?: Record<string, unknown>;
}): string | null {
  const tryParse = (content: string): unknown | null => {
    try {
      return parse(content, toolSchema, {
        ...(parseOptions ?? {}),
        repair: false,
        onError: undefined,
      });
    } catch {
      return null;
    }
  };

  const strictFull = tryParse(toolContent);
  if (
    strictFull !== null &&
    isStableXmlProgressCandidate({
      candidate: toolContent,
      parsed: strictFull,
      toolSchema,
    })
  ) {
    return JSON.stringify(strictFull);
  }

  let searchEnd = toolContent.length;
  while (searchEnd > 0) {
    const gtIndex = toolContent.lastIndexOf(">", searchEnd - 1);
    if (gtIndex === -1) {
      break;
    }
    const candidate = toolContent.slice(0, gtIndex + 1);
    if (!analyzeXmlFragmentForProgress(candidate)) {
      searchEnd = gtIndex;
      continue;
    }
    const parsedCandidate = tryParse(candidate);
    if (
      parsedCandidate !== null &&
      isStableXmlProgressCandidate({
        candidate,
        parsed: parsedCandidate,
        toolSchema,
      })
    ) {
      return JSON.stringify(parsedCandidate);
    }
    searchEnd = gtIndex;
  }

  return null;
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
    const finalInput = JSON.stringify(parsedResult);
    emitFinalRemainder({
      controller: ctrl,
      id: currentToolCall.toolCallId,
      state: currentToolCall,
      finalFullJson: finalInput,
      onMismatch: options?.onError,
    });
    ctrl.enqueue({
      type: "tool-input-end",
      id: currentToolCall.toolCallId,
    });
    ctrl.enqueue({
      type: "tool-call",
      toolCallId: currentToolCall.toolCallId,
      toolName: currentToolCall.name,
      input: finalInput,
    });
  } catch (error) {
    ctrl.enqueue({
      type: "tool-input-end",
      id: currentToolCall.toolCallId,
    });
    const original = `<${currentToolCall.name}>${toolContent}</${currentToolCall.name}>`;
    options?.onError?.("Could not process streaming XML tool call", {
      toolCall: original,
      error,
    });
    if (shouldEmitRawToolCallTextOnError(options)) {
      flushText(ctrl, original);
    }
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

interface TokenHandlerResult {
  depth: number;
  lastCompleteEnd: number;
  shouldBreak: boolean;
}

function handleSpecialToken(depth: number): TokenHandlerResult {
  return { depth, lastCompleteEnd: -1, shouldBreak: false };
}

function handleOpenToken(
  token: { selfClosing: boolean; nextPos: number },
  depth: number,
  lastCompleteEnd: number
): TokenHandlerResult {
  if (token.selfClosing) {
    return {
      depth,
      lastCompleteEnd: depth === 0 ? token.nextPos : lastCompleteEnd,
      shouldBreak: false,
    };
  }
  return { depth: depth + 1, lastCompleteEnd, shouldBreak: false };
}

function handleCloseToken(
  token: { nextPos: number },
  depth: number
): TokenHandlerResult {
  if (depth <= 0) {
    return { depth, lastCompleteEnd: -1, shouldBreak: true };
  }
  const newDepth = depth - 1;
  return {
    depth: newDepth,
    lastCompleteEnd: newDepth === 0 ? token.nextPos : -1,
    shouldBreak: false,
  };
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

    let result: TokenHandlerResult;
    if (token.kind === "special") {
      result = handleSpecialToken(depth);
    } else if (token.kind === "open") {
      result = handleOpenToken(token, depth, lastCompleteEnd);
    } else {
      result = handleCloseToken(token, depth);
    }

    depth = result.depth;
    if (result.lastCompleteEnd !== -1) {
      lastCompleteEnd = result.lastCompleteEnd;
    }
    if (result.shouldBreak) {
      break;
    }
    cursor = token.nextPos;
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

interface StreamingToolCallState {
  name: string;
  toolCallId: string;
  emittedInput: string;
  lastProgressGtIndex: number | null;
  lastProgressFullInput: string | null;
}

interface ProcessToolCallInBufferParams {
  buffer: string;
  currentToolCall: StreamingToolCallState;
  tools: LanguageModelV3FunctionTool[];
  options?: ParserOptions;
  controller: TransformStreamDefaultController<LanguageModelV3StreamPart>;
  flushText: FlushTextFn;
  setBuffer: (buffer: string) => void;
  parseOptions?: Record<string, unknown>;
  emitToolInputProgress: (
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
    currentToolCall: StreamingToolCallState,
    toolContent: string
  ) => void;
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
  } = params;
  const endTagPattern = new RegExp(
    `</\\s*${escapeRegExp(currentToolCall.name)}\\s*>`
  );
  const endMatch = endTagPattern.exec(buffer);
  if (!endMatch || endMatch.index === undefined) {
    emitToolInputProgress(controller, currentToolCall, buffer);
    return { buffer, currentToolCall, shouldBreak: true };
  }

  const endIdx = endMatch.index;
  const endPos = endIdx + endMatch[0].length;
  const content = buffer.substring(0, endIdx);
  emitToolInputProgress(controller, currentToolCall, content);
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
  emitToolInputStart: (
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
    toolName: string
  ) => StreamingToolCallState;
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
  const newBuffer = buffer.substring(earliestStartTagIndex + startTag.length);
  setBuffer(newBuffer);
  return {
    buffer: newBuffer,
    currentToolCall: emitToolInputStart(controller, earliestToolName),
    shouldBreak: false,
    shouldContinue: true,
  };
}

function createProcessBufferHandler(
  getBuffer: () => string,
  setBuffer: (buffer: string) => void,
  getCurrentToolCall: () => StreamingToolCallState | null,
  setCurrentToolCall: (toolCall: StreamingToolCallState | null) => void,
  tools: LanguageModelV3FunctionTool[],
  options: ParserOptions | undefined,
  toolNames: string[],
  flushText: FlushTextFn,
  parseOptions: Record<string, unknown> | undefined,
  emitToolInputProgress: (
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
    currentToolCall: StreamingToolCallState,
    toolContent: string
  ) => void,
  emitToolInputStart: (
    controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
    toolName: string
  ) => StreamingToolCallState
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
          emitToolInputProgress,
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
          emitToolInputStart,
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

function findToolCallsWithFallbacks(
  text: string,
  toolNames: string[]
): { parseText: string; toolCalls: ReturnType<typeof findToolCalls> } {
  let parseText = text;
  let toolCalls = findToolCalls(parseText, toolNames);

  if (toolCalls.length === 0) {
    const fallbackToolCall = findLinePrefixedToolCall(parseText, toolNames);
    if (fallbackToolCall !== null) {
      toolCalls.push(fallbackToolCall);
    }
  }

  if (toolCalls.length === 0) {
    const repaired = tryRepairXmlSelfClosingRootWithBody(parseText, toolNames);
    if (repaired) {
      const repairedCalls = findToolCalls(repaired, toolNames);
      if (repairedCalls.length > 0) {
        parseText = repaired;
        toolCalls = repairedCalls;
      }
    }
  }

  return { parseText, toolCalls };
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

      const { parseText, toolCalls } = findToolCallsWithFallbacks(
        text,
        toolNames
      );

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
      let currentToolCall: StreamingToolCallState | null = null;
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

      const emitToolInputStart = (
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
        toolName: string
      ): StreamingToolCallState => {
        flushText(controller);
        const next: StreamingToolCallState = {
          name: toolName,
          toolCallId: generateToolCallId(),
          emittedInput: "",
          lastProgressGtIndex: null,
          lastProgressFullInput: null,
        };
        controller.enqueue({
          type: "tool-input-start",
          id: next.toolCallId,
          toolName,
        });
        return next;
      };

      const emitToolInputProgress = (
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
        toolCall: StreamingToolCallState,
        toolContent: string
      ) => {
        const progressGtIndex = toolContent.lastIndexOf(">");
        if (toolCall.lastProgressGtIndex === progressGtIndex) {
          const cached = toolCall.lastProgressFullInput;
          if (cached == null) {
            return;
          }
          if (cached === "{}" && toolContent.trim().length === 0) {
            return;
          }
          const prefixCandidate = toIncompleteJsonPrefix(cached);
          emitPrefixDelta({
            controller,
            id: toolCall.toolCallId,
            state: toolCall,
            candidate: prefixCandidate,
          });
          return;
        }

        const toolSchema = getToolSchema(tools, toolCall.name);
        const fullInput = parseXmlContentForStreamProgress({
          toolContent,
          toolSchema,
          parseOptions,
        });
        toolCall.lastProgressGtIndex = progressGtIndex;
        toolCall.lastProgressFullInput = fullInput;
        if (fullInput == null) {
          return;
        }
        if (fullInput === "{}" && toolContent.trim().length === 0) {
          return;
        }
        const prefixCandidate = toIncompleteJsonPrefix(fullInput);
        emitPrefixDelta({
          controller,
          id: toolCall.toolCallId,
          state: toolCall,
          candidate: prefixCandidate,
        });
      };

      const finalizeUnclosedToolCall = (
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
      ) => {
        if (!currentToolCall) {
          return;
        }

        emitToolInputProgress(controller, currentToolCall, buffer);
        const parseConfig = {
          ...parseOptions,
          onError:
            options?.onError ??
            (parseOptions as { onError?: ParserOptions["onError"] } | undefined)
              ?.onError,
        };

        const toolSchema = getToolSchema(tools, currentToolCall.name);
        flushText(controller);
        try {
          if (hasNonWhitespaceTopLevelText(buffer)) {
            throw new Error(
              "Cannot reconcile unclosed XML tool call with top-level plain text."
            );
          }
          const parsedResult = parse(buffer, toolSchema, parseConfig);
          const finalInput = JSON.stringify(parsedResult);
          emitFinalRemainder({
            controller,
            id: currentToolCall.toolCallId,
            state: currentToolCall,
            finalFullJson: finalInput,
            onMismatch: options?.onError,
          });
          controller.enqueue({
            type: "tool-input-end",
            id: currentToolCall.toolCallId,
          });
          controller.enqueue({
            type: "tool-call",
            toolCallId: currentToolCall.toolCallId,
            toolName: currentToolCall.name,
            input: finalInput,
          });
        } catch (error) {
          controller.enqueue({
            type: "tool-input-end",
            id: currentToolCall.toolCallId,
          });
          const unfinishedContent = `<${currentToolCall.name}>${buffer}`;
          options?.onError?.(
            "Could not complete streaming XML tool call at finish.",
            { toolCall: unfinishedContent, error }
          );
          if (shouldEmitRawToolCallTextOnError(options)) {
            flushText(controller, unfinishedContent);
          }
        }

        buffer = "";
        currentToolCall = null;
      };

      const processBuffer = createProcessBufferHandler(
        () => buffer,
        (newBuffer: string) => {
          buffer = newBuffer;
        },
        () => currentToolCall,
        (newToolCall: StreamingToolCallState | null) => {
          currentToolCall = newToolCall;
        },
        tools,
        options,
        toolNames,
        flushText,
        parseOptions,
        emitToolInputProgress,
        emitToolInputStart
      );

      return new TransformStream({
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Stateful stream parsing requires branching over chunk lifecycle and parser states.
        transform(chunk, controller) {
          if (chunk.type === "finish") {
            if (currentToolCall) {
              finalizeUnclosedToolCall(controller);
            } else if (buffer) {
              flushText(controller, buffer);
              buffer = "";
            }
            flushText(controller);
            controller.enqueue(chunk);
            return;
          }

          if (chunk.type !== "text-delta") {
            if (currentToolCall) {
              // Keep an open XML tool call alive across non-text stream chunks
              // so mixed-mode streams (e.g. reasoning) can continue to complete it.
            } else if (buffer) {
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
            finalizeUnclosedToolCall(controller);
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
