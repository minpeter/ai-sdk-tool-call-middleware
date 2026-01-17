import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider";
import { parse, stringify } from "@ai-sdk-tool/rxml";
import { generateId } from "../utils/id";
import type { TCMCoreProtocol } from "./protocol-interface";

export interface XmlProtocolOptions {
  parseOptions?: {
    repair?: boolean;
    maxReparses?: number;
    onError?: (message: string, metadata?: Record<string, unknown>) => void;
    noChildNodes?: string[];
    [key: string]: unknown;
  };
}

interface ParserOptions {
  onError?: (message: string, metadata?: Record<string, unknown>) => void;
}

type FlushTextFn = (
  controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
  text?: string
) => void;

const NAME_CHAR_RE = /[A-Za-z0-9_:-]/;
const WHITESPACE_REGEX = /\s/;
const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
  return value.replace(REGEX_ESCAPE_RE, "\\$&");
}

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
}

function findNextToolTag(
  text: string,
  searchIndex: number,
  startTag: string,
  selfTag: string
): ToolTagMatch | null {
  const openIdx = text.indexOf(startTag, searchIndex);
  const selfIdx = text.indexOf(selfTag, searchIndex);
  if (openIdx === -1 && selfIdx === -1) {
    return null;
  }
  const isSelfClosing = selfIdx !== -1 && (openIdx === -1 || selfIdx < openIdx);
  return {
    tagStart: isSelfClosing ? selfIdx : openIdx,
    isSelfClosing,
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
  selfTag: string
): number {
  const endIndex = tagStart + selfTag.length;
  toolCalls.push({
    toolName,
    startIndex: tagStart,
    endIndex,
    content: "",
    segment: text.substring(tagStart, endIndex),
  });
  return endIndex;
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
  const selfTag = `<${toolName}/>`;
  let searchIndex = 0;

  while (searchIndex < text.length) {
    const match = findNextToolTag(text, searchIndex, startTag, selfTag);
    if (match === null) {
      break;
    }
    if (match.isSelfClosing) {
      searchIndex = pushSelfClosingToolCall(
        toolCalls,
        toolName,
        text,
        match.tagStart,
        selfTag
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

      const toolCalls = findToolCalls(text, toolNames);

      for (const tc of toolCalls) {
        if (tc.startIndex > currentIndex) {
          processedElements.push({
            type: "text",
            text: text.substring(currentIndex, tc.startIndex),
          });
        }
        processToolCall({
          toolCall: tc,
          tools,
          options,
          text,
          processedElements,
          parseOptions,
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
        parseOptions
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
