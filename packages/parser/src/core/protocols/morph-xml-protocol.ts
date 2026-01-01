import {
  extractRawInner,
  parse,
  stringify,
  unwrapJsonSchema,
} from "@ai-sdk-tool/rxml";
import {
  applyHeuristicPipeline as _applyHeuristicPipeline,
  createIntermediateCall as _createIntermediateCall,
  defaultPipelineConfig as _defaultPipelineConfig,
  type PipelineConfig as _PipelineConfig,
  type ToolCallHeuristic as _ToolCallHeuristic,
  balanceTags,
  dedupeSingleTag,
  escapeInvalidLt,
  getStringPropertyNames,
  repairParsedAgainstSchema,
  shouldDeduplicateStringTags,
} from "../heuristics";
import type {
  TCMCoreContentPart,
  TCMCoreFunctionTool,
  TCMCoreStreamPart,
  TCMCoreToolCall,
  TCMCoreToolResult,
} from "../types";
import { generateId } from "../utils/id";
import type { ToolCallProtocol } from "./tool-call-protocol";

const defaultPipelineConfig = _defaultPipelineConfig;
type PipelineConfig = _PipelineConfig;
type ToolCallHeuristic = _ToolCallHeuristic;

export interface MorphXmlProtocolOptions {
  heuristics?: ToolCallHeuristic[];
  pipeline?: PipelineConfig;
  maxReparses?: number;
}

interface ParserOptions {
  onError?: (message: string, metadata?: Record<string, unknown>) => void;
}

type FlushTextFn = (
  controller: TransformStreamDefaultController<TCMCoreStreamPart>,
  text?: string
) => void;

const NAME_CHAR_RE = /[A-Za-z0-9_:-]/;
const WHITESPACE_REGEX = /\s/;

function getToolSchema(tools: TCMCoreFunctionTool[], toolName: string) {
  return tools.find((t) => t.name === toolName)?.inputSchema;
}

function normalizeCloseTags(xml: string): string {
  return xml.replace(/<\/\s+([A-Za-z0-9_:-]+)\s*>/g, "</$1>");
}

function tryParseSecondaryXml(
  content: string,
  toolSchema: unknown,
  options: {
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
  }
): unknown | null {
  const balanced = balanceTags(content);
  try {
    let parsed: unknown = parse(balanced, toolSchema, {
      onError: options?.onError,
      noChildNodes: [],
    });
    parsed = repairParsedAgainstSchema(parsed, toolSchema);
    return parsed;
  } catch {
    if (shouldDeduplicateStringTags(toolSchema)) {
      const names = getStringPropertyNames(toolSchema);
      let deduped = balanced;
      for (const key of names) {
        deduped = dedupeSingleTag(deduped, key);
      }
      if (deduped !== balanced) {
        try {
          let reparsed: unknown = parse(deduped, toolSchema, {
            onError: options?.onError,
            noChildNodes: [],
          });
          reparsed = repairParsedAgainstSchema(reparsed, toolSchema);
          return reparsed;
        } catch {
          return null;
        }
      }
    }
    return null;
  }
}

interface ProcessToolCallParams {
  toolCall: {
    toolName: string;
    content: string;
    startIndex: number;
    endIndex: number;
  };
  tools: TCMCoreFunctionTool[];
  options?: ParserOptions;
  text: string;
  processedElements: TCMCoreContentPart[];
  pipelineConfig?: PipelineConfig;
  maxReparses?: number;
}

function processToolCallWithPipeline(params: ProcessToolCallParams): void {
  const {
    toolCall,
    tools,
    options,
    text,
    processedElements,
    pipelineConfig = defaultPipelineConfig,
    maxReparses,
  } = params;
  const toolSchema = getToolSchema(tools, toolCall.toolName);

  const ctx = _createIntermediateCall(
    toolCall.toolName,
    toolCall.content,
    toolSchema
  );

  const result = _applyHeuristicPipeline(ctx, pipelineConfig, {
    parse: (xml: string, schema: unknown) =>
      parse(xml, schema, { onError: options?.onError, noChildNodes: [] }),
    onError: options?.onError,
    maxReparses,
  });

  if (result.parsed !== null) {
    processedElements.push({
      type: "tool-call",
      toolCallId: generateId(),
      toolName: toolCall.toolName,
      input: JSON.stringify(result.parsed),
    });
  } else {
    const originalCallText = text.substring(
      toolCall.startIndex,
      toolCall.endIndex
    );
    options?.onError?.(
      `Could not process XML tool call: ${toolCall.toolName}`,
      { toolCall: originalCallText, error: result.errors[0] }
    );
    processedElements.push({ type: "text", text: originalCallText });
  }
}

interface HandleStreamingToolCallEndParams {
  toolContent: string;
  currentToolCall: { name: string; content?: string };
  tools: TCMCoreFunctionTool[];
  options?: ParserOptions;
  ctrl: TransformStreamDefaultController<TCMCoreStreamPart>;
  flushText: FlushTextFn;
  pipelineConfig?: PipelineConfig;
  maxReparses?: number;
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
    pipelineConfig,
    maxReparses,
  } = params;
  const toolSchema = getToolSchema(tools, currentToolCall.name);
  let parsedResult: unknown | null = null;

  if (pipelineConfig) {
    const ctx = _createIntermediateCall(
      currentToolCall.name,
      toolContent,
      toolSchema
    );
    const result = _applyHeuristicPipeline(ctx, pipelineConfig, {
      parse: (xml: string, schema: unknown) =>
        parse(xml, schema, { onError: options?.onError, noChildNodes: [] }),
      onError: options?.onError,
      maxReparses,
    });
    parsedResult = result.parsed;
  } else {
    try {
      const primary = escapeInvalidLt(normalizeCloseTags(toolContent));
      const parsed = parse(primary, toolSchema, {
        onError: options?.onError,
        noChildNodes: [],
      });
      parsedResult = repairParsedAgainstSchema(parsed, toolSchema);
    } catch {
      parsedResult = tryParseSecondaryXml(
        toolContent,
        toolSchema,
        options ?? {}
      );
    }
  }

  flushText(ctrl);
  if (parsedResult !== null) {
    ctrl.enqueue({
      type: "tool-call",
      toolCallId: generateId(),
      toolName: currentToolCall.name,
      input: JSON.stringify(parsedResult),
    });
  } else {
    const original = `<${currentToolCall.name}>${toolContent}</${currentToolCall.name}>`;
    options?.onError?.("Could not process streaming XML tool call", {
      toolCall: original,
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
    const startTag = `<${toolName}>`;
    const selfTag = `<${toolName}/>`;
    const openIdx = text.indexOf(startTag, searchIndex);
    const selfIdx = text.indexOf(selfTag, searchIndex);

    if (openIdx === -1 && selfIdx === -1) {
      break;
    }

    const tagStart =
      selfIdx !== -1 && (openIdx === -1 || selfIdx < openIdx)
        ? selfIdx
        : openIdx;
    const isSelfClosing = tagStart === selfIdx;
    if (isSelfClosing) {
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

function createFlushTextHandler(
  getCurrentTextId: () => string | null,
  setCurrentTextId: (id: string | null) => void,
  getHasEmittedTextStart: () => boolean,
  setHasEmittedTextStart: (value: boolean) => void
) {
  return (
    controller: TransformStreamDefaultController<TCMCoreStreamPart>,
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
        textDelta: content,
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
  tools: TCMCoreFunctionTool[];
  options?: ParserOptions;
  controller: TransformStreamDefaultController<TCMCoreStreamPart>;
  flushText: FlushTextFn;
  setBuffer: (buffer: string) => void;
  pipelineConfig?: PipelineConfig;
  maxReparses?: number;
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
    pipelineConfig,
    maxReparses,
  } = params;
  const endTag = `</${currentToolCall.name}>`;
  const endIdx = buffer.indexOf(endTag);

  if (endIdx === -1) {
    return { buffer, currentToolCall, shouldBreak: true };
  }

  const content = buffer.substring(0, endIdx);
  setBuffer(buffer.substring(endIdx + endTag.length));

  handleStreamingToolCallEnd({
    toolContent: content,
    currentToolCall,
    tools,
    options,
    ctrl: controller,
    flushText,
    pipelineConfig,
    maxReparses,
  });

  return {
    buffer: buffer.substring(endIdx + endTag.length),
    currentToolCall: null,
    shouldBreak: false,
  };
}

interface ProcessNoToolCallInBufferParams {
  buffer: string;
  toolNames: string[];
  controller: TransformStreamDefaultController<TCMCoreStreamPart>;
  flushText: FlushTextFn;
  tools: TCMCoreFunctionTool[];
  options?: ParserOptions;
  pipelineConfig?: PipelineConfig;
  maxReparses?: number;
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
    pipelineConfig,
    maxReparses,
    setBuffer,
  } = params;
  const {
    index: earliestStartTagIndex,
    name: earliestToolName,
    selfClosing,
  } = findEarliestToolTag(buffer, toolNames);

  if (earliestStartTagIndex === -1) {
    const maxTagLen = toolNames.length
      ? Math.max(...toolNames.map((n) => `<${n}>`.length))
      : 0;
    const tail = Math.max(0, maxTagLen - 1);
    const safeLen = Math.max(0, buffer.length - tail);
    if (safeLen > 0) {
      flushText(controller, buffer.slice(0, safeLen));
      setBuffer(buffer.slice(safeLen));
    }
    return {
      buffer: buffer.slice(safeLen),
      currentToolCall: null,
      shouldBreak: true,
      shouldContinue: false,
    };
  }

  flushText(controller, buffer.substring(0, earliestStartTagIndex));

  if (selfClosing) {
    const selfTag = `<${earliestToolName}/>`;
    const newBuffer = buffer.substring(earliestStartTagIndex + selfTag.length);
    setBuffer(newBuffer);
    handleStreamingToolCallEnd({
      toolContent: "",
      currentToolCall: { name: earliestToolName, content: "" },
      tools,
      options,
      ctrl: controller,
      flushText,
      pipelineConfig,
      maxReparses,
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
  tools: TCMCoreFunctionTool[],
  options: ParserOptions | undefined,
  toolNames: string[],
  flushText: FlushTextFn,
  pipelineConfig?: PipelineConfig,
  maxReparses?: number
) {
  return (controller: TransformStreamDefaultController<TCMCoreStreamPart>) => {
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
          pipelineConfig,
          maxReparses,
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
          pipelineConfig,
          maxReparses,
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

export const morphXmlProtocol = (
  protocolOptions?: MorphXmlProtocolOptions
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: protocol factory with multiple parsing strategies
): ToolCallProtocol => {
  let pipelineConfig = protocolOptions?.pipeline;
  const maxReparses = protocolOptions?.maxReparses;

  if (protocolOptions?.heuristics && protocolOptions.heuristics.length > 0) {
    const heuristicsConfig: _PipelineConfig = {
      preParse: [],
      fallbackReparse: [],
      postParse: [],
    };
    for (const h of protocolOptions.heuristics) {
      if (h.phase === "pre-parse") {
        heuristicsConfig.preParse?.push(h);
      } else if (h.phase === "fallback-reparse") {
        heuristicsConfig.fallbackReparse?.push(h);
      } else if (h.phase === "post-parse") {
        heuristicsConfig.postParse?.push(h);
      }
    }
    if (pipelineConfig) {
      pipelineConfig = {
        preParse: [
          ...(pipelineConfig.preParse ?? []),
          ...(heuristicsConfig.preParse ?? []),
        ],
        fallbackReparse: [
          ...(pipelineConfig.fallbackReparse ?? []),
          ...(heuristicsConfig.fallbackReparse ?? []),
        ],
        postParse: [
          ...(pipelineConfig.postParse ?? []),
          ...(heuristicsConfig.postParse ?? []),
        ],
      };
    } else {
      pipelineConfig = heuristicsConfig;
    }
  }

  return {
    formatTools({ tools, toolSystemPromptTemplate }) {
      const toolsForPrompt = (tools || []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: unwrapJsonSchema(tool.inputSchema),
      }));
      return toolSystemPromptTemplate(JSON.stringify(toolsForPrompt));
    },

    formatToolCall(toolCall: TCMCoreToolCall): string {
      let args: unknown = {};
      try {
        args = JSON.parse(toolCall.input);
      } catch {
        args = toolCall.input;
      }
      return stringify(toolCall.toolName, args, {
        suppressEmptyNode: false,
        format: false,
      });
    },

    formatToolResponse(toolResult: TCMCoreToolResult): string {
      let result = toolResult.result;

      // Handle cases where the result is wrapped in { type: 'json', value: ... }
      if (
        result &&
        typeof result === "object" &&
        "type" in result &&
        (result as { type: unknown }).type === "json" &&
        "value" in result
      ) {
        result = (result as { value: unknown }).value;
      }

      const xml = stringify(
        "tool_response",
        {
          tool_name: toolResult.toolName,
          result,
        },
        { declaration: false }
      );
      return xml;
    },

    parseGeneratedText({ text, tools, options }) {
      const toolNames = tools.map((t) => t.name).filter(Boolean) as string[];
      if (toolNames.length === 0) {
        return [{ type: "text", text }];
      }

      const processedElements: TCMCoreContentPart[] = [];
      let currentIndex = 0;

      const toolCalls = findToolCalls(text, toolNames);

      for (const tc of toolCalls) {
        if (tc.startIndex > currentIndex) {
          processedElements.push({
            type: "text",
            text: text.substring(currentIndex, tc.startIndex),
          });
        }
        processToolCallWithPipeline({
          toolCall: tc,
          tools,
          options,
          text,
          processedElements,
          pipelineConfig,
          maxReparses,
        });
        currentIndex = tc.endIndex;
      }

      if (currentIndex < text.length) {
        processedElements.push({
          type: "text",
          text: text.substring(currentIndex),
        });
      }

      return processedElements;
    },

    createStreamParser({ tools, options }) {
      const toolNames = tools.map((t) => t.name).filter(Boolean) as string[];
      let buffer = "";
      // biome-ignore lint/suspicious/noExplicitAny: internal state
      let currentToolCall: any = null;
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
        pipelineConfig,
        maxReparses
      );

      return new TransformStream({
        transform(chunk, controller) {
          if (chunk.type !== "text-delta") {
            if (buffer) {
              flushText(controller, buffer);
              buffer = "";
            }
            controller.enqueue(chunk);
            return;
          }

          const textContent =
            chunk.textDelta ??
            (chunk as unknown as { delta?: string }).delta ??
            "";
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
