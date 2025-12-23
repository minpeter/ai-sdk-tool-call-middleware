import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3ToolCall,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import {
  extractRawInner,
  parse,
  RXMLCoercionError,
  RXMLDuplicateStringTagError,
  RXMLParseError,
  stringify,
  unwrapJsonSchema,
} from "@ai-sdk-tool/rxml";

import { hasInputProperty } from "../utils/type-guards";

import type { ToolCallProtocol } from "./tool-call-protocol";

// Regex constants for performance
const WHITESPACE_REGEX = /\s/;
const MALFORMED_CLOSE_RE = /<\/\s+([A-Za-z0-9_:-]+)\s*>/;
const MALFORMED_CLOSE_RE_G = /<\/\s+([A-Za-z0-9_:-]+)\s*>/g;
const NAME_CHAR_RE = /[A-Za-z0-9_:-]/;
const STATUS_TO_STEP_BOUNDARY_RE = /<\/status>\s*<step>/g;
const STEP_TAG_RE = /<step>([\s\S]*?)<\/step>/i;
const STATUS_TAG_RE = /<status>([\s\S]*?)<\/status>/i;

// Helper functions to reduce cognitive complexity

function normalizeCloseTags(xml: string): string {
  // Normalize malformed closing tags like </ step> or </\n name   > to </name>
  return xml.replace(MALFORMED_CLOSE_RE_G, "</$1>");
}

function escapeInvalidLt(xml: string): string {
  const len = xml.length;
  let out = "";
  for (let i = 0; i < len; i += 1) {
    const ch = xml[i];
    if (ch === "<") {
      const next = i + 1 < len ? xml[i + 1] : "";
      if (
        !(
          NAME_CHAR_RE.test(next) ||
          next === "/" ||
          next === "!" ||
          next === "?"
        )
      ) {
        out += "&lt;";
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function shouldDeduplicateStringTags(schema: unknown): boolean {
  const unwrapped = unwrapJsonSchema(schema as unknown) as Record<
    string,
    unknown
  >;
  if (!unwrapped || typeof unwrapped !== "object") {
    return false;
  }
  const props = (unwrapped as { properties?: Record<string, unknown> })
    .properties as Record<string, unknown> | undefined;
  if (!props) {
    return false;
  }
  const commandRaw = (props as Record<string, unknown>).command as unknown;
  if (!commandRaw) {
    return false;
  }
  const command = unwrapJsonSchema(commandRaw) as { type?: string } | undefined;
  return command?.type === "array";
}

function tryParseSecondaryXml(
  content: string,
  toolSchema: unknown,
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined
): unknown | null {
  const normalized = normalizeCloseTags(content);
  const balanced = balanceTags(content);
  const hasMalformedClose = MALFORMED_CLOSE_RE.test(content);
  if (!hasMalformedClose && balanced.length > normalized.length) {
    return null;
  }
  try {
    let parsed: unknown = parse(balanced, toolSchema, {
      onError: options?.onError,
      noChildNodes: [],
    });
    parsed = repairParsedAgainstSchema(parsed, toolSchema, options);
    return parsed;
  } catch (_e) {
    // Only attempt dedupe of duplicate string tags for shell-like tools
    // where schema contains a 'command' array property.
    if (shouldDeduplicateStringTags(toolSchema)) {
      const deduped = dedupeStringTagsAgainstSchema(balanced, toolSchema);
      if (deduped !== balanced) {
        try {
          let reparsed: unknown = parse(deduped, toolSchema, {
            onError: options?.onError,
            noChildNodes: [],
          });
          reparsed = repairParsedAgainstSchema(reparsed, toolSchema, options);
          return reparsed;
        } catch (_) {
          return null;
        }
      }
    }
    return null;
  }
}

function balanceTags(xml: string): string {
  // Normalize malformed closings and insert a missing </step> boundary
  // when a new <step> starts right after </status>
  const src = normalizeCloseTags(xml).replace(
    STATUS_TO_STEP_BOUNDARY_RE,
    "</status></step><step>"
  );
  let i = 0;
  const len = src.length;
  const out: string[] = [];
  const stack: string[] = [];

  while (i < len) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      out.push(src.slice(i));
      break;
    }
    out.push(src.slice(i, lt));
    if (lt + 1 >= len) {
      break;
    }
    const next = src[lt + 1];
    if (next === "!" || next === "?") {
      i = handleSpecialTagSegment(src, lt, out);
      continue;
    }
    if (next === "/") {
      i = handleClosingTagSegment(src, lt, out, stack);
      continue;
    }
    i = handleOpeningTagSegment(src, lt, out, stack);
  }

  for (let k = stack.length - 1; k >= 0; k -= 1) {
    out.push(`</${stack[k]}>`);
  }
  return out.join("");
}

function skipWs(s: string, p: number, len: number): number {
  let idx = p;
  while (idx < len && WHITESPACE_REGEX.test(s[idx])) {
    idx += 1;
  }
  return idx;
}

function parseTagNameAt(
  s: string,
  p: number,
  len: number
): { name: string; pos: number } {
  let idx = p;
  const start = idx;
  while (idx < len && NAME_CHAR_RE.test(s[idx])) {
    idx += 1;
  }
  return { name: s.slice(start, idx), pos: idx };
}

function handleSpecialTagSegment(
  src: string,
  lt: number,
  out: string[]
): number {
  const gt = src.indexOf(">", lt + 1);
  if (gt === -1) {
    out.push(src.slice(lt));
    return src.length;
  }
  out.push(src.slice(lt, gt + 1));
  return gt + 1;
}

function handleClosingTagSegment(
  src: string,
  lt: number,
  out: string[],
  stack: string[]
): number {
  const len = src.length;
  let p = skipWs(src, lt + 2, len);
  const { name, pos } = parseTagNameAt(src, p, len);
  p = pos;
  const gt = src.indexOf(">", p);
  const closingText = gt === -1 ? src.slice(lt) : src.slice(lt, gt + 1);
  const idx = stack.lastIndexOf(name);
  if (idx !== -1) {
    for (let k = stack.length - 1; k > idx; k -= 1) {
      out.push(`</${stack[k]}>`);
      stack.pop();
    }
    out.push(closingText);
    stack.pop();
  }
  return gt === -1 ? len : gt + 1;
}

function handleOpeningTagSegment(
  src: string,
  lt: number,
  out: string[],
  stack: string[]
): number {
  const len = src.length;
  let p = skipWs(src, lt + 1, len);
  const nameStart = p;
  const parsed = parseTagNameAt(src, p, len);
  p = parsed.pos;
  const name = src.slice(nameStart, p);
  const q = src.indexOf(">", p);
  if (q === -1) {
    out.push(src.slice(lt));
    return len;
  }
  let r = q - 1;
  while (r >= nameStart && WHITESPACE_REGEX.test(src[r])) {
    r -= 1;
  }
  const selfClosing = src[r] === "/";
  out.push(src.slice(lt, q + 1));
  if (!selfClosing && name) {
    stack.push(name);
  }
  return q + 1;
}

function repairParsedAgainstSchema(
  input: unknown,
  schema: unknown,
  options?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
): unknown {
  if (!input || typeof input !== "object") {
    return input;
  }
  const unwrapped = unwrapJsonSchema(schema as unknown) as Record<
    string,
    unknown
  >;
  if (!unwrapped || typeof unwrapped !== "object") {
    return input;
  }
  const properties = (unwrapped as { properties?: Record<string, unknown> })
    .properties;
  if (!properties) {
    return input;
  }
  applySchemaProps(input as Record<string, unknown>, properties, options);
  return input;
}

function applySchemaProps(
  obj: Record<string, unknown>,
  properties: Record<string, unknown>,
  options?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
): void {
  for (const key of Object.keys(obj)) {
    const propSchema = (properties as Record<string, unknown>)[key];
    if (!propSchema) {
      continue;
    }
    const prop = unwrapJsonSchema(propSchema as unknown) as unknown;
    const propType = (prop as { type?: string }).type;
    if (propType === "array" && (prop as { items?: unknown }).items) {
      const itemSchemaRaw = (prop as { items?: unknown }).items;
      const itemSchema = unwrapJsonSchema(itemSchemaRaw) as unknown;
      obj[key] = coerceArrayItems(obj[key], itemSchema, options) as unknown;
      continue;
    }
    if (propType === "object") {
      const val = obj[key];
      if (val && typeof val === "object") {
        obj[key] = repairParsedAgainstSchema(
          val as unknown,
          prop,
          options
        ) as unknown;
      }
    }
  }
}

function coerceArrayItems(
  val: unknown,
  itemSchema: unknown,
  options?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
): unknown[] | unknown {
  if (!Array.isArray(val)) {
    return val as unknown;
  }
  return (val as unknown[]).map((v) => coerceArrayItem(v, itemSchema, options));
}

function coerceArrayItem(
  v: unknown,
  itemSchema: unknown,
  options?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
): unknown {
  const itemType = (itemSchema as { type?: string })?.type;
  if (typeof v === "string" && itemType === "object") {
    const parsed = tryParseStringToSchemaObject(v, itemSchema, options);
    if (parsed !== null) {
      return parsed as unknown;
    }
    const fallback = extractStepStatusFromString(normalizeCloseTags(v));
    if (fallback) {
      return fallback as unknown;
    }
    return v;
  }
  if (v && typeof v === "object" && itemType === "object") {
    return repairParsedAgainstSchema(
      v as unknown,
      itemSchema,
      options
    ) as unknown;
  }
  return v;
}

function getStringPropertyNames(schema: unknown): string[] {
  const unwrapped = unwrapJsonSchema(schema as unknown) as Record<
    string,
    unknown
  >;
  if (!unwrapped || typeof unwrapped !== "object") {
    return [];
  }
  const props = (unwrapped as { properties?: Record<string, unknown> })
    .properties;
  if (!props) {
    return [];
  }
  const names: string[] = [];
  for (const key of Object.keys(props)) {
    const prop = unwrapJsonSchema(
      (props as Record<string, unknown>)[key] as unknown
    ) as unknown;
    const type = (prop as { type?: string }).type;
    if (type === "string") {
      names.push(key);
    }
  }
  return names;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

function dedupeStringTagsAgainstSchema(xml: string, schema: unknown): string {
  const names = getStringPropertyNames(schema);
  let out = xml;
  for (const key of names) {
    out = dedupeSingleTag(out, key);
  }
  return out;
}

function dedupeSingleTag(xml: string, key: string): string {
  const escaped = escapeRegExp(key);
  const re = new RegExp(`<${escaped}>([\\s\\S]*?)<\\/${escaped}>`, "g");
  const matches = Array.from(xml.matchAll(re));
  if (matches.length <= 1) {
    return xml;
  }
  const last = matches.at(-1);
  let result = "";
  let cursor = 0;
  for (const m of matches) {
    const idx = m.index ?? 0;
    result += xml.slice(cursor, idx);
    if (last && idx === (last.index ?? -1)) {
      result += m[0];
    }
    cursor = idx + m[0].length;
  }
  result += xml.slice(cursor);
  return result;
}

function tryParseStringToSchemaObject(
  xml: string,
  itemSchema: unknown,
  options?: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
): unknown | null {
  try {
    const fixed = parse(normalizeCloseTags(xml), itemSchema, {
      onError: options?.onError,
      noChildNodes: [],
    });
    return typeof fixed === "string" ? null : (fixed as unknown);
  } catch {
    return null;
  }
}

function extractStepStatusFromString(
  normXml: string
): Record<string, string> | null {
  const stepMatch = normXml.match(STEP_TAG_RE);
  const statusMatch = normXml.match(STATUS_TAG_RE);
  if (stepMatch && statusMatch) {
    return { step: stepMatch[1], status: statusMatch[1] };
  }
  return null;
}

function processTextBeforeToolCall(
  text: string,
  currentIndex: number,
  toolCallStartIndex: number,
  processedElements: LanguageModelV3Content[]
): number {
  if (toolCallStartIndex > currentIndex) {
    const textSegment = text.substring(currentIndex, toolCallStartIndex);
    if (textSegment.trim()) {
      processedElements.push({ type: "text", text: textSegment });
    }
  }
  return currentIndex;
}

interface ToolCallInfo {
  toolName: string;
  content: string;
  startIndex: number;
  endIndex: number;
}

interface ProcessToolCallParams {
  toolCall: ToolCallInfo;
  tools: LanguageModelV3FunctionTool[];
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  text: string;
  processedElements: LanguageModelV3Content[];
}

function processToolCall(params: ProcessToolCallParams): void {
  const { toolCall, tools, options, text, processedElements } = params;
  const toolSchema = getToolSchema(tools, toolCall.toolName);
  try {
    const primary = escapeInvalidLt(normalizeCloseTags(toolCall.content));
    let parsed: unknown = parse(primary, toolSchema, {
      onError: options?.onError,
      // Disable HTML self-closing tag behavior to allow base, meta, link etc. as regular tags
      noChildNodes: [],
    });
    parsed = repairParsedAgainstSchema(parsed, toolSchema, options);
    processedElements.push({
      type: "tool-call",
      toolCallId: generateId(),
      toolName: toolCall.toolName,
      input: JSON.stringify(parsed),
    });
  } catch (error) {
    const reparsed = tryParseSecondaryXml(
      toolCall.content,
      toolSchema,
      options
    );
    if (reparsed !== null) {
      processedElements.push({
        type: "tool-call",
        toolCallId: generateId(),
        toolName: toolCall.toolName,
        input: JSON.stringify(reparsed),
      });
      return;
    }
    const originalCallText = text.substring(
      toolCall.startIndex,
      toolCall.endIndex
    );
    const message = `Could not process XML tool call, keeping original text: ${originalCallText}`;
    options?.onError?.(message, {
      toolCall: originalCallText,
      toolName: toolCall.toolName,
      error,
    });
    processedElements.push({ type: "text", text: originalCallText });
  }
}

function addRemainingText(
  text: string,
  currentIndex: number,
  processedElements: LanguageModelV3Content[]
): void {
  if (currentIndex < text.length) {
    const remainingText = text.substring(currentIndex);
    if (remainingText.trim()) {
      processedElements.push({ type: "text", text: remainingText });
    }
  }
}

interface StreamingToolCallEndParams {
  toolContent: string;
  currentToolCall: { name: string; content: string };
  tools: LanguageModelV3FunctionTool[];
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  ctrl: TransformStreamDefaultController;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
}

function handleStreamingToolCallEnd(params: StreamingToolCallEndParams): void {
  const { toolContent, currentToolCall, tools, options, ctrl, flushText } =
    params;
  const toolSchema = getToolSchema(tools, currentToolCall.name);
  try {
    const primary = escapeInvalidLt(normalizeCloseTags(toolContent));
    let parsed: unknown = parse(primary, toolSchema, {
      onError: options?.onError,
      noChildNodes: [],
    });
    parsed = repairParsedAgainstSchema(parsed, toolSchema, options);

    // Close any open text segment before emitting tool-call
    flushText(ctrl);

    ctrl.enqueue({
      type: "tool-call",
      toolCallId: generateId(),
      toolName: currentToolCall.name,
      input: JSON.stringify(parsed),
    });
  } catch (error) {
    const parsed = tryParseSecondaryXml(toolContent, toolSchema, options);
    if (parsed !== null) {
      flushText(ctrl);
      ctrl.enqueue({
        type: "tool-call",
        toolCallId: generateId(),
        toolName: currentToolCall.name,
        input: JSON.stringify(parsed),
      });
      return;
    }
    handleStreamingToolCallError({
      error,
      currentToolCall,
      toolContent,
      options,
      ctrl,
      flushText,
    });
  }
}

interface StreamingToolCallErrorParams {
  error: unknown;
  currentToolCall: { name: string; content: string };
  toolContent: string;
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  ctrl: TransformStreamDefaultController;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
}

function handleStreamingToolCallError(
  params: StreamingToolCallErrorParams
): void {
  const { error, currentToolCall, toolContent, options, ctrl, flushText } =
    params;
  const endTag = `</${currentToolCall.name}>`;
  const originalCallText = `<${currentToolCall.name}>${toolContent}${endTag}`;
  let message =
    "Could not process streaming XML tool call; emitting original text.";

  if (error instanceof RXMLDuplicateStringTagError) {
    message = `Duplicate string tags detected in streaming tool call '${currentToolCall.name}'; emitting original text.`;
  } else if (error instanceof RXMLCoercionError) {
    message = `Failed to coerce arguments for streaming tool call '${currentToolCall.name}'; emitting original text.`;
  } else if (error instanceof RXMLParseError) {
    message = `Failed to parse XML for streaming tool call '${currentToolCall.name}'; emitting original text.`;
  }

  options?.onError?.(message, {
    toolCall: originalCallText,
    toolName: currentToolCall.name,
    error,
  });
  flushText(ctrl, originalCallText);
}

function findEarliestToolTag(
  buffer: string,
  toolNames: string[]
): { index: number; name: string; selfClosing: boolean } {
  let bestIndex = -1;
  let bestName = "";
  let bestSelfClosing = false;

  if (toolNames.length > 0) {
    for (const name of toolNames) {
      const openTag = `<${name}>`;
      const selfTag = `<${name}/>`;
      const idxOpen = buffer.indexOf(openTag);
      const idxSelf = buffer.indexOf(selfTag);

      if (idxOpen !== -1 && (bestIndex === -1 || idxOpen < bestIndex)) {
        bestIndex = idxOpen;
        bestName = name;
        bestSelfClosing = false;
      }
      if (idxSelf !== -1 && (bestIndex === -1 || idxSelf < bestIndex)) {
        bestIndex = idxSelf;
        bestName = name;
        bestSelfClosing = true;
      }
    }
  }

  return { index: bestIndex, name: bestName, selfClosing: bestSelfClosing };
}

function handleNoToolTagInBuffer(
  buffer: string,
  maxStartTagLen: number,
  controller: TransformStreamDefaultController,
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void
): { buffer: string; shouldContinue: boolean } {
  const tail = Math.max(0, maxStartTagLen - 1);
  const safeLen = Math.max(0, buffer.length - tail);
  if (safeLen > 0) {
    const textToFlush = buffer.slice(0, safeLen);
    flushText(controller, textToFlush);
    return { buffer: buffer.slice(safeLen), shouldContinue: true };
  }
  return { buffer, shouldContinue: false };
}

interface ProcessToolCallInBufferParams {
  buffer: string;
  currentToolCall: { name: string; content: string };
  tools: LanguageModelV3FunctionTool[];
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  controller: TransformStreamDefaultController;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
  setBuffer: (buffer: string) => void;
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
  } = params;
  const endTag = `</${currentToolCall.name}>`;
  // Normalize malformed closings in buffer to enable detection
  const normalized = normalizeCloseTags(buffer);
  const effectiveBuffer = normalized;
  const endTagIndex = effectiveBuffer.indexOf(endTag);

  if (endTagIndex !== -1) {
    const toolContent = effectiveBuffer.substring(0, endTagIndex);
    const newBuffer = effectiveBuffer.substring(endTagIndex + endTag.length);

    // Clear buffer BEFORE calling handleStreamingToolCallEnd
    // so that flushText(ctrl) emits text-end without emitting buffer content
    setBuffer("");

    handleStreamingToolCallEnd({
      toolContent,
      currentToolCall,
      tools,
      options,
      ctrl: controller,
      flushText,
    });

    // Restore buffer to content after tool call
    setBuffer(newBuffer);
    return { buffer: newBuffer, currentToolCall: null, shouldBreak: false };
  }
  return { buffer: effectiveBuffer, currentToolCall, shouldBreak: true };
}

interface ProcessNoToolCallInBufferParams {
  buffer: string;
  toolNames: string[];
  maxStartTagLen: number;
  controller: TransformStreamDefaultController;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
  tools: LanguageModelV3FunctionTool[];
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
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
    maxStartTagLen,
    controller,
    flushText,
    tools,
    options,
  } = params;
  const {
    index: earliestStartTagIndex,
    name: earliestToolName,
    selfClosing,
  } = findEarliestToolTag(buffer, toolNames);

  if (earliestStartTagIndex !== -1) {
    const textBeforeTag = buffer.substring(0, earliestStartTagIndex);
    flushText(controller, textBeforeTag);

    if (selfClosing) {
      const selfTag = `<${earliestToolName}/>`;
      const newBuffer = buffer.substring(
        earliestStartTagIndex + selfTag.length
      );
      // Emit tool call immediately with empty content
      handleStreamingToolCallEnd({
        toolContent: "",
        currentToolCall: { name: earliestToolName, content: "" },
        tools,
        options,
        ctrl: controller,
        flushText,
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
    return {
      buffer: newBuffer,
      currentToolCall: { name: earliestToolName, content: "" },
      shouldBreak: false,
      shouldContinue: false,
    };
  }

  const result = handleNoToolTagInBuffer(
    buffer,
    maxStartTagLen,
    controller,
    flushText
  );
  return {
    buffer: result.buffer,
    currentToolCall: null,
    shouldBreak: !result.shouldContinue,
    shouldContinue: result.shouldContinue,
  };
}

function createFlushTextHandler(
  getBuffer: () => string,
  setBuffer: (buffer: string) => void,
  getCurrentTextId: () => string | null,
  setCurrentTextId: (id: string | null) => void
) {
  return (controller: TransformStreamDefaultController, text?: string) => {
    const content = text ?? getBuffer();
    if (content) {
      const currentTextId = getCurrentTextId();
      if (!currentTextId) {
        const newId = generateId();
        setCurrentTextId(newId);
        controller.enqueue({ type: "text-start", id: newId });
      }
      controller.enqueue({
        type: "text-delta",
        id: getCurrentTextId() as string,
        delta: content,
      });
      if (text === undefined) {
        setBuffer("");
      }
    }

    const currentTextId = getCurrentTextId();
    if (currentTextId && !text) {
      controller.enqueue({ type: "text-end", id: currentTextId });
      setCurrentTextId(null);
    }
  };
}

interface ProcessBufferHandlerParams {
  getBuffer: () => string;
  setBuffer: (buffer: string) => void;
  getCurrentToolCall: () => { name: string; content: string } | null;
  setCurrentToolCall: (
    toolCall: { name: string; content: string } | null
  ) => void;
  tools: LanguageModelV3FunctionTool[];
  options:
    | {
        onError?: (message: string, metadata?: Record<string, unknown>) => void;
      }
    | undefined;
  toolNames: string[];
  maxStartTagLen: number;
  flushText: (ctrl: TransformStreamDefaultController, text?: string) => void;
}

function processBufferWithToolCall(
  params: ProcessBufferHandlerParams,
  controller: TransformStreamDefaultController
): boolean {
  const {
    getBuffer,
    setBuffer,
    getCurrentToolCall,
    setCurrentToolCall,
    tools,
    options,
    flushText,
  } = params;
  const currentToolCall = getCurrentToolCall();

  if (!currentToolCall) {
    return true;
  }

  const result = processToolCallInBuffer({
    buffer: getBuffer(),
    currentToolCall,
    tools,
    options,
    controller,
    flushText,
    setBuffer,
  });
  setBuffer(result.buffer);
  setCurrentToolCall(result.currentToolCall);
  return result.shouldBreak;
}

function processBufferWithoutToolCall(
  params: ProcessBufferHandlerParams,
  controller: TransformStreamDefaultController
): { shouldBreak: boolean; shouldContinue: boolean } {
  const {
    getBuffer,
    setBuffer,
    setCurrentToolCall,
    tools,
    options,
    toolNames,
    maxStartTagLen,
    flushText,
  } = params;

  const result = processNoToolCallInBuffer({
    buffer: getBuffer(),
    toolNames,
    maxStartTagLen,
    controller,
    flushText,
    tools,
    options,
  });
  setBuffer(result.buffer);
  setCurrentToolCall(result.currentToolCall);
  return {
    shouldBreak: result.shouldBreak,
    shouldContinue: result.shouldContinue,
  };
}

function processBufferLoop(
  params: ProcessBufferHandlerParams,
  controller: TransformStreamDefaultController
): void {
  while (true) {
    const currentToolCall = params.getCurrentToolCall();
    if (currentToolCall) {
      const shouldBreak = processBufferWithToolCall(params, controller);
      if (shouldBreak) {
        break;
      }
    } else {
      const { shouldBreak, shouldContinue } = processBufferWithoutToolCall(
        params,
        controller
      );
      if (shouldContinue) {
        continue;
      }
      if (shouldBreak) {
        break;
      }
    }
  }
}

function createProcessBufferHandler(params: ProcessBufferHandlerParams) {
  return (controller: TransformStreamDefaultController) => {
    processBufferLoop(params, controller);
  };
}

export const morphXmlProtocol = (): ToolCallProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    const toolsForPrompt = (tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: unwrapJsonSchema(tool.inputSchema),
    }));
    return toolSystemPromptTemplate(JSON.stringify(toolsForPrompt));
  },

  formatToolCall(toolCall: LanguageModelV3ToolCall): string {
    let args: unknown = {};
    const inputValue = hasInputProperty(toolCall) ? toolCall.input : undefined;

    if (typeof inputValue === "string") {
      try {
        args = JSON.parse(inputValue);
      } catch {
        args = inputValue;
      }
    } else {
      args = inputValue;
    }
    return stringify(toolCall.toolName, args, {
      suppressEmptyNode: false,
      format: false,
    });
  },

  formatToolResponse(toolResult: LanguageModelV3ToolResultPart): string {
    return stringify("tool_response", {
      tool_name: toolResult.toolName,
      result: toolResult.output,
    });
  },

  parseGeneratedText({ text, tools, options }) {
    const toolNames = tools.map((t) => t.name).filter((name) => name != null);
    if (toolNames.length === 0) {
      return [{ type: "text", text }];
    }

    const processedElements: LanguageModelV3Content[] = [];
    let currentIndex = 0;

    const toolCallsRaw = findToolCalls(text, toolNames);
    const toolCallsNorm = collectToolCallsFromNormalizedText(text, toolNames);
    const seen = new Set<string>();
    const toolCalls = [...toolCallsRaw, ...toolCallsNorm]
      .filter((tc) => {
        const key = `${tc.toolName}:${tc.startIndex}:${tc.endIndex}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.startIndex - b.startIndex);

    // Process text and tool calls in order
    for (const toolCall of toolCalls) {
      // Add text before this tool call
      currentIndex = processTextBeforeToolCall(
        text,
        currentIndex,
        toolCall.startIndex,
        processedElements
      );

      // Process the tool call
      processToolCall({ toolCall, tools, options, text, processedElements });

      currentIndex = toolCall.endIndex;
    }

    // Add remaining text
    addRemainingText(text, currentIndex, processedElements);

    return processedElements;
  },

  createStreamParser({ tools, options }) {
    const toolNames = tools.map((t) => t.name).filter((name) => name != null);
    const maxStartTagLen = toolNames.length
      ? Math.max(...toolNames.map((n) => `<${n}>`.length))
      : 0;
    let buffer = "";
    let currentToolCall: { name: string; content: string } | null = null;
    let currentTextId: string | null = null;

    const flushText = createFlushTextHandler(
      () => buffer,
      (newBuffer: string) => {
        buffer = newBuffer;
      },
      () => currentTextId,
      (newId: string | null) => {
        currentTextId = newId;
      }
    );

    const processChunk = (
      chunk: { type: string; delta?: string },
      controller: TransformStreamDefaultController
    ) => {
      if (chunk.type !== "text-delta") {
        if (buffer) {
          flushText(controller);
        }
        controller.enqueue(chunk);
        return;
      }

      buffer += chunk.delta;
      processBuffer(controller);
    };

    const processBuffer = createProcessBufferHandler({
      getBuffer: () => buffer,
      setBuffer: (newBuffer: string) => {
        buffer = newBuffer;
      },
      getCurrentToolCall: () => currentToolCall,
      setCurrentToolCall: (
        newToolCall: { name: string; content: string } | null
      ) => {
        currentToolCall = newToolCall;
      },
      tools,
      options,
      toolNames,
      maxStartTagLen,
      flushText,
    });

    const flushBuffer = (controller: TransformStreamDefaultController) => {
      if (currentToolCall) {
        const unfinishedCall = `<${currentToolCall.name}>${buffer}`;
        flushText(controller, unfinishedCall);
      } else if (buffer) {
        flushText(controller);
      }

      if (currentTextId) {
        controller.enqueue({ type: "text-end", id: currentTextId });
      }
    };

    return new TransformStream({
      transform(chunk, controller) {
        processChunk(chunk, controller);
      },
      flush(controller) {
        flushBuffer(controller);
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
});

export function getToolSchema(
  tools: LanguageModelV3FunctionTool[],
  toolName: string
) {
  return tools.find((t) => t.name === toolName)?.inputSchema;
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
  if (next !== "!" && next !== "?") {
    return null;
  }
  const gt = text.indexOf(">", lt + 1);
  if (gt === -1) {
    return null;
  }
  return gt + 1;
}

function consumeClosingTag(
  text: string,
  lt: number,
  toolName: string
): { matched: boolean; endPos: number } {
  let p = lt + 2;
  while (p < text.length && WHITESPACE_REGEX.test(text[p])) {
    p += 1;
  }
  if (text.slice(p, p + toolName.length) === toolName) {
    p += toolName.length;
    while (p < text.length && WHITESPACE_REGEX.test(text[p])) {
      p += 1;
    }
    if (text[p] === ">") {
      const endPos = p + 1;
      return { matched: true, endPos };
    }
  }
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
    const closing = consumeClosingTag(text, lt, "");
    // We still need the tag name; re-parse minimally here
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

function collectToolCallsFromNormalizedText(
  text: string,
  toolNames: string[]
): Array<{
  toolName: string;
  startIndex: number;
  endIndex: number;
  content: string;
  segment: string;
}> {
  const normalizedText = normalizeCloseTags(text);
  const collected: Array<{
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
    segment: string;
  }> = [];
  for (const toolName of toolNames) {
    const startTag = `<${toolName}>`;
    let idx = 0;
    let lastOrigIdx = 0;
    while (idx < normalizedText.length) {
      const tagStartNorm = normalizedText.indexOf(startTag, idx);
      if (tagStartNorm === -1) {
        break;
      }
      const contentStartNorm = tagStartNorm + startTag.length;
      const endNorm = findClosingTagEndFlexible(
        normalizedText,
        contentStartNorm,
        toolName
      );
      if (endNorm > contentStartNorm) {
        const tagStartOrig = text.indexOf(startTag, lastOrigIdx);
        const contentStartOrig = tagStartOrig + startTag.length;
        let endOrig = findClosingTagEndFlexible(
          text,
          contentStartOrig,
          toolName
        );
        if (endOrig === -1) {
          const approxLen = endNorm - tagStartNorm;
          endOrig = Math.min(text.length, tagStartOrig + approxLen);
        }
        const segment = text.substring(tagStartOrig, endOrig);
        const inner =
          extractRawInner(segment, toolName) ??
          segment.substring(startTag.length, segment.lastIndexOf("<"));
        collected.push({
          toolName,
          startIndex: tagStartOrig,
          endIndex: endOrig,
          content: inner,
          segment,
        });
        lastOrigIdx = endOrig;
        idx = endNorm;
      } else {
        idx = contentStartNorm;
      }
    }
  }
  return collected.sort((a, b) => a.startIndex - b.startIndex);
}

function getNextTagInfo(
  text: string,
  toolName: string,
  fromIndex: number
): {
  found: boolean;
  tagStart: number;
  selfClosing: boolean;
  startTag: string;
  selfTag: string;
} {
  const startTag = `<${toolName}>`;
  const selfTag = `<${toolName}/>`;
  const openIdx = text.indexOf(startTag, fromIndex);
  const selfIdx = text.indexOf(selfTag, fromIndex);
  const hasOpen = openIdx !== -1;
  const hasSelf = selfIdx !== -1;
  if (!(hasOpen || hasSelf)) {
    return {
      found: false,
      tagStart: -1,
      selfClosing: false,
      startTag,
      selfTag,
    };
  }
  const pickSelf = hasSelf && (!hasOpen || selfIdx < openIdx);
  const tagStart = pickSelf ? selfIdx : openIdx;
  return { found: true, tagStart, selfClosing: pickSelf, startTag, selfTag };
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
  let searchIndex = 0;

  while (searchIndex < text.length) {
    const info = getNextTagInfo(text, toolName, searchIndex);
    if (!info.found) {
      break;
    }

    const { tagStart, selfClosing, startTag, selfTag } = info;

    if (selfClosing) {
      const endIndex = tagStart + selfTag.length;
      const segment = text.substring(tagStart, endIndex);
      toolCalls.push({
        toolName,
        startIndex: tagStart,
        endIndex,
        content: "",
        segment,
      });
      searchIndex = endIndex;
      continue;
    }

    const contentStart = tagStart + startTag.length;
    const fullTagEnd = findClosingTagEndFlexible(text, contentStart, toolName);
    if (fullTagEnd !== -1 && fullTagEnd > contentStart) {
      const segment = text.substring(tagStart, fullTagEnd);
      const inner =
        extractRawInner(segment, toolName) ??
        segment.substring(startTag.length, segment.lastIndexOf("<"));
      toolCalls.push({
        toolName,
        startIndex: tagStart,
        endIndex: fullTagEnd,
        content: inner,
        segment,
      });
      searchIndex = fullTagEnd;
    } else {
      searchIndex = contentStart;
    }
  }

  return toolCalls;
}

// Shared helper to find tool call ranges for a given set of tool names
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
