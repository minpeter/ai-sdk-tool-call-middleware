import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import { generateToolCallId } from "../utils/id";
import {
  consumeMarkdownCodeText,
  createMarkdownCodeContext,
  markdownCodeContextSuppressesToolCall,
} from "../utils/markdown-code-context";
import {
  addTextSegment,
  formatToolsWithPromptTemplate,
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import { shouldEmitRawToolCallTextOnError } from "../utils/tool-input-streaming";
import { parseGlm5AnchoredBareToolCall } from "./glm5-bare-tool-call";
import {
  type Glm5CallSnapshot,
  type Glm5ProtocolOptions,
  hasExplicitlyClosedGlm5TaggedBody,
  parseGlm5CallBody,
  resolveGlm5ProtocolOptions,
  stringifyGlm5CallInput,
} from "./glm5-call-parsing";
import { registerGlm5FastPaths } from "./glm5-fast-path-registry";
import { createGlm5StreamParser } from "./glm5-stream-parser";
import type { ParserOptions, TCMProtocol } from "./protocol-interface";

interface TagMatch {
  end: number;
  raw: string;
  start: number;
}

interface ClosedCallSelection {
  close: TagMatch;
  parsed: Glm5CallSnapshot | null;
  rejected: boolean;
}

const TOOL_CALL_OPEN_RE = /<\s*tool_call\s*>/gi;
const TOOL_CALL_CLOSE_RE = /<\s*\/\s*tool_call\s*>/gi;
const STRUCTURAL_RECOVERY_CODES = new Set([
  "recovered-missing-arg-key-close",
  "recovered-missing-arg-value-close",
]);
const MAX_GLM5_TOOL_CALL_CLOSE_CANDIDATES = 256;

function findTag(text: string, from: number, pattern: RegExp): TagMatch | null {
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  if (!match) {
    return null;
  }
  const start = match.index;
  return {
    end: start + match[0].length,
    raw: match[0],
    start,
  };
}

function isTrimEndWhitespace(character: string | undefined): boolean {
  switch (character) {
    case "\u0009":
    case "\u000a":
    case "\u000b":
    case "\u000c":
    case "\u000d":
    case "\u0020":
    case "\u00a0":
    case "\u1680":
    case "\u2000":
    case "\u2001":
    case "\u2002":
    case "\u2003":
    case "\u2004":
    case "\u2005":
    case "\u2006":
    case "\u2007":
    case "\u2008":
    case "\u2009":
    case "\u200a":
    case "\u2028":
    case "\u2029":
    case "\u202f":
    case "\u205f":
    case "\u3000":
    case "\ufeff":
      return true;
    default:
      return false;
  }
}

function isDefinitelyPlainGlm5Text(text: string): boolean {
  // biome-ignore lint/style/useForOf: Indexed primitive-string reads avoid a mutable String.prototype iterator.
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "<" || character === "{" || character === "[") {
      return false;
    }
  }

  let tail = text.length - 1;
  while (tail >= 0 && isTrimEndWhitespace(text[tail])) {
    tail -= 1;
  }
  if (tail < 0) {
    return false;
  }
  if (text[tail] === ";") {
    tail -= 1;
    while (tail >= 0 && isTrimEndWhitespace(text[tail])) {
      tail -= 1;
    }
  }
  return text[tail] !== ")";
}

function parseToolCallInput(input: unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return {};
  }
}

function formatArgumentValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}

function formatGlm5ToolCall(toolCall: LanguageModelV4ToolCall): string {
  const parsed = parseToolCallInput(toolCall.input);
  let output = `<tool_call>${toolCall.toolName}`;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      output += `<arg_key>${key}</arg_key><arg_value>${formatArgumentValue(value)}</arg_value>`;
    }
  }
  return `${output}</tool_call>`;
}

function reportRecovery(
  options: ParserOptions | undefined,
  raw: string,
  toolName: string,
  recoveryCodes: string[]
): void {
  if (recoveryCodes.length === 0) {
    return;
  }
  options?.onError?.("Recovered malformed GLM-5.2 tool call.", {
    recoveryCodes,
    toolCall: safeToolCallMetadataText(raw),
    toolName,
  });
}

function reportFailure(
  options: ParserOptions | undefined,
  raw: string,
  error?: unknown
): void {
  options?.onError?.("Could not parse GLM-5.2 tool call.", {
    dropReason: "malformed-glm5-tool-call",
    ...(error === undefined
      ? {}
      : { error: safeToolCallMetadataError(error, raw) }),
    toolCall: safeToolCallMetadataText(raw),
  });
}

function appendRawFallback(
  output: LanguageModelV4Content[],
  raw: string,
  options?: ParserOptions
): void {
  if (
    shouldEmitRawToolCallTextOnError(options) &&
    !toolCallTextHasPrototypeSensitiveKey(raw)
  ) {
    addTextSegment(raw, output);
  }
}

function hasStructuralRecovery(call: Glm5CallSnapshot): boolean {
  return call.recoveries.some((code) => STRUCTURAL_RECOVERY_CODES.has(code));
}

function selectClosedCall(options: {
  open: TagMatch;
  protocolOptions: ReturnType<typeof resolveGlm5ProtocolOptions>;
  text: string;
  tools: LanguageModelV4FunctionTool[];
}): ClosedCallSelection | null {
  const nestedOpen = findTag(options.text, options.open.end, TOOL_CALL_OPEN_RE);
  let cursor = options.open.end;
  let candidateCount = 0;
  let first: { close: TagMatch; parsed: Glm5CallSnapshot | null } | null = null;
  let last: { close: TagMatch; parsed: Glm5CallSnapshot | null } | null = null;
  let recoverable: {
    close: TagMatch;
    parsed: Glm5CallSnapshot;
  } | null = null;

  while (cursor < options.text.length) {
    const close = findTag(options.text, cursor, TOOL_CALL_CLOSE_RE);
    if (!close) {
      break;
    }
    candidateCount += 1;
    if (candidateCount > MAX_GLM5_TOOL_CALL_CLOSE_CANDIDATES) {
      return { close, parsed: null, rejected: true };
    }
    const body = options.text.slice(options.open.end, close.start);
    const parsed = parseGlm5CallBody({
      body,
      complete: true,
      protocolOptions: options.protocolOptions,
      tools: options.tools,
    });
    first ??= { close, parsed };
    last = { close, parsed };
    if (!parsed && hasExplicitlyClosedGlm5TaggedBody(body)) {
      return { close, parsed: null, rejected: false };
    }
    if (parsed && !hasStructuralRecovery(parsed)) {
      return { close, parsed, rejected: false };
    }
    if (parsed && !recoverable) {
      recoverable = { close, parsed };
    }
    cursor = close.end;
  }

  if (nestedOpen && last) {
    return { close: last.close, parsed: null, rejected: true };
  }
  if (recoverable) {
    return { ...recoverable, rejected: false };
  }
  return first ? { ...first, rejected: false } : null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: candidate selection, fail-closed recovery, and text preservation require explicit branches.
function parseGeneratedText(options: {
  parserOptions?: ParserOptions;
  protocolOptions: ReturnType<typeof resolveGlm5ProtocolOptions>;
  text: string;
  tools: LanguageModelV4FunctionTool[];
}): LanguageModelV4Content[] {
  const output: LanguageModelV4Content[] = [];
  const markdownContext = createMarkdownCodeContext();
  let cursor = 0;

  while (cursor < options.text.length) {
    const open = findTag(options.text, cursor, TOOL_CALL_OPEN_RE);
    if (!open) {
      addTextSegment(options.text.slice(cursor), output);
      break;
    }
    const leadingText = options.text.slice(cursor, open.start);
    consumeMarkdownCodeText(markdownContext, leadingText);
    const insideMarkdownCode =
      markdownCodeContextSuppressesToolCall(markdownContext);
    addTextSegment(leadingText, output);

    const selected = selectClosedCall({
      open,
      protocolOptions: options.protocolOptions,
      text: options.text,
      tools: options.tools,
    });
    if (insideMarkdownCode) {
      const rawEnd = selected?.close.end ?? options.text.length;
      const rawText = options.text.slice(open.start, rawEnd);
      consumeMarkdownCodeText(markdownContext, rawText);
      addTextSegment(rawText, output);
      cursor = rawEnd;
      if (!selected) {
        break;
      }
      continue;
    }
    const close = selected?.close ?? null;
    const complete = close !== null;
    if (selected?.rejected) {
      const raw = options.text.slice(open.start, selected.close.end);
      reportFailure(options.parserOptions, raw);
      appendRawFallback(output, raw, options.parserOptions);
      cursor = selected.close.end;
      continue;
    }
    const nestedOpenWithoutClose =
      !complete && findTag(options.text, open.end, TOOL_CALL_OPEN_RE) !== null;
    if (nestedOpenWithoutClose) {
      const raw = options.text.slice(open.start);
      reportFailure(options.parserOptions, raw);
      appendRawFallback(output, raw, options.parserOptions);
      break;
    }
    if (!(complete || options.protocolOptions.recoverIncompleteToolCalls)) {
      const raw = options.text.slice(open.start);
      reportFailure(options.parserOptions, raw);
      appendRawFallback(output, raw, options.parserOptions);
      break;
    }

    const bodyEnd = close?.start ?? options.text.length;
    const rawEnd = close?.end ?? options.text.length;
    const raw = options.text.slice(open.start, rawEnd);
    const parsed =
      selected === null
        ? parseGlm5CallBody({
            body: options.text.slice(open.end, bodyEnd),
            complete: true,
            protocolOptions: options.protocolOptions,
            tools: options.tools,
          })
        : selected.parsed;
    if (parsed) {
      try {
        const input = stringifyGlm5CallInput(parsed, options.tools);
        output.push({
          type: "tool-call",
          input,
          toolCallId: generateToolCallId(),
          toolName: parsed.toolName,
        });
        reportRecovery(options.parserOptions, raw, parsed.toolName, [
          ...parsed.recoveries,
          ...(complete ? [] : ["recovered-missing-tool-call-close"]),
        ]);
      } catch (error) {
        reportFailure(options.parserOptions, raw, error);
        appendRawFallback(output, raw, options.parserOptions);
      }
    } else {
      reportFailure(options.parserOptions, raw);
      appendRawFallback(output, raw, options.parserOptions);
    }
    cursor = rawEnd;
    if (!complete) {
      break;
    }
  }

  if (output.some((part) => part.type === "tool-call")) {
    return output;
  }

  const bareCall = parseGlm5AnchoredBareToolCall({
    text: options.text,
    tools: options.tools,
  });
  if (!bareCall) {
    return output;
  }
  return [
    {
      type: "tool-call",
      input: bareCall.input,
      toolCallId: generateToolCallId(),
      toolName: bareCall.toolName,
    },
  ];
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Extraction mirrors parser recovery, Markdown non-execution, and resynchronization branches explicitly.
function extractToolCallSegments(
  text: string,
  tools: LanguageModelV4FunctionTool[],
  protocolOptions: ReturnType<typeof resolveGlm5ProtocolOptions>
): string[] {
  const segments: string[] = [];
  const markdownContext = createMarkdownCodeContext();
  let cursor = 0;
  while (cursor < text.length) {
    const open = findTag(text, cursor, TOOL_CALL_OPEN_RE);
    if (!open) {
      break;
    }
    consumeMarkdownCodeText(markdownContext, text.slice(cursor, open.start));
    const insideMarkdownCode =
      markdownCodeContextSuppressesToolCall(markdownContext);
    const selected = selectClosedCall({
      open,
      protocolOptions,
      text,
      tools,
    });
    if (insideMarkdownCode) {
      const rawEnd = selected?.close.end ?? text.length;
      consumeMarkdownCodeText(markdownContext, text.slice(open.start, rawEnd));
      cursor = rawEnd;
      continue;
    }
    if (selected?.rejected) {
      break;
    }
    if (!selected) {
      const nestedOpen = findTag(text, open.end, TOOL_CALL_OPEN_RE);
      if (protocolOptions.recoverIncompleteToolCalls && !nestedOpen) {
        const raw = text.slice(open.start);
        const parsed = parseGlm5CallBody({
          body: text.slice(open.end),
          complete: true,
          protocolOptions,
          tools,
        });
        if (parsed) {
          segments.push(raw);
        }
      }
      break;
    }
    if (selected.parsed) {
      segments.push(text.slice(open.start, selected.close.end));
    }
    cursor = selected.close.end;
  }
  if (segments.length > 0) {
    return segments;
  }
  return parseGlm5AnchoredBareToolCall({ text, tools }) ? [text.trim()] : [];
}

export function glm5Protocol(options?: Glm5ProtocolOptions): TCMProtocol {
  const protocolOptions = resolveGlm5ProtocolOptions(options);
  const protocol: TCMProtocol = {
    createStreamParser(params) {
      return createGlm5StreamParser({ ...params, protocolOptions });
    },

    extractToolCallSegments({ text, tools }) {
      return extractToolCallSegments(text, tools, protocolOptions);
    },

    formatToolCall: formatGlm5ToolCall,

    formatTools({ tools, toolSystemPromptTemplate }) {
      return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
    },

    parseGeneratedText({ text, tools, options: parserOptions }) {
      return parseGeneratedText({
        parserOptions,
        protocolOptions,
        text,
        tools,
      });
    },
  };
  registerGlm5FastPaths(protocol.parseGeneratedText, {
    isDefinitelyPlainGeneratedText: isDefinitelyPlainGlm5Text,
  });
  return protocol;
}
