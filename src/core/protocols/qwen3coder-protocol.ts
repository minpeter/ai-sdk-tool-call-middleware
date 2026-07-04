import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import {
  escapeXmlMinimalAttr,
  escapeXmlMinimalText,
} from "../../rxml/utils/helpers";
import { recoverToolCallFromJsonCandidates } from "../utils/generated-text-json-recovery";
import { getPotentialStartIndex } from "../utils/get-potential-start-index";
import { generateToolCallId } from "../utils/id";
import {
  createFlushTextHandler,
  formatToolsWithPromptTemplate,
} from "../utils/protocol-utils";
import { escapeRegExp } from "../utils/regex";
import {
  emitFailedToolInputLifecycle,
  emitFinalizedToolInputLifecycle,
  emitToolInputProgressDelta,
  enqueueToolInputEndAndCall,
  shouldEmitRawToolCallTextOnError,
  stringifyToolInputWithSchema,
} from "../utils/tool-input-streaming";
import type { TCMProtocol } from "./protocol-interface";
import {
  buildSchemaParamNameMap,
  CALL_BLOCK_RE,
  extractQwen3CoderToolNameFromMarkup,
  extractShorthandToolNameFromRaw,
  findImplicitCallOpenIndices,
  getAttributeValue,
  getPotentialTagStartIndex,
  getShorthandValue,
  mergeArgsWithPartialParam,
  mergeParamValue,
  normalizeStreamToolCallInnerOpenVariants,
  normalizeToolCallInnerOpenVariants,
  normalizeXmlTextValue,
  parseQwen3CoderToolParserParamTagAt,
  parseQwen3CoderToolParserToolCallSegment,
  parseSingleFunctionCallXml,
  QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_NAME_TAG_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE,
  QWEN3CODER_TOOL_PARSER_STREAM_TOOL_CALL_CLOSE_TAG_RE,
  SALVAGE_MARKUP_ONLY_TEXT_REGEX,
  sanitizePartialParamValueForProgress,
  splitImplicitCallAndTail,
  stripLeadingCallCloseTags,
  stripLeadingToolCallCloseTags,
  stripTrailingToolCallCloseTags,
  TOOL_CALL_BLOCK_RE,
  TOOL_CALL_CLOSE_RE,
  TOOL_CALL_OPEN_RE,
} from "./qwen3coder-call-parsing";
import type { QwenStreamCallState } from "./qwen3coder-stream-call-content";
import { parseCallContent } from "./qwen3coder-stream-call-content";

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;

const XML_TOOL_CALL_CLOSED_CALL_BLOCK_RE =
  /<(call|function|tool|invoke)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const XML_TAG_RE = /<\s*(\/)?\s*([A-Za-z_][\w.:-]*)\b[^>]*>/g;
const XML_VALUE_TAG_NAMES = new Set(["parameter", "param", "argument", "arg"]);

function extractToolCallBody(markup: string): string | null {
  const open = TOOL_CALL_OPEN_RE.exec(markup);
  if (!open) {
    return null;
  }
  const bodyStart = (open.index ?? 0) + open[0].length;
  const rest = markup.slice(bodyStart);
  const close = TOOL_CALL_CLOSE_RE.exec(rest);
  const bodyEnd =
    close?.index == null ? markup.length : bodyStart + close.index;
  return markup.slice(bodyStart, bodyEnd);
}

function isValueTagName(
  tagName: string,
  tools: LanguageModelV4FunctionTool[],
  toolName: string | null
): boolean {
  const normalized = tagName.toLowerCase();
  if (XML_VALUE_TAG_NAMES.has(normalized)) {
    return true;
  }
  if (!toolName) {
    return false;
  }
  const tool = tools.find((candidate) => candidate.name === toolName);
  const properties = (
    tool?.inputSchema as
      | { properties?: Record<string, unknown> }
      | null
      | undefined
  )?.properties;
  return Object.keys(properties ?? {}).some(
    (property) => property.toLowerCase() === normalized
  );
}

function lastXmlTagBefore(
  body: string,
  endIndex: number
): { closing: boolean; name: string } | null {
  let last: { closing: boolean; name: string } | null = null;
  XML_TAG_RE.lastIndex = 0;
  for (const match of body.matchAll(XML_TAG_RE)) {
    const matchEnd = (match.index ?? 0) + match[0].length;
    if (matchEnd > endIndex) {
      break;
    }
    last = { closing: Boolean(match[1]), name: match[2] ?? "" };
  }
  return last;
}

function hasProseOutsideXmlCalls(
  markup: string,
  tools: LanguageModelV4FunctionTool[]
): boolean {
  const body = extractToolCallBody(markup);
  if (body === null) {
    return false;
  }
  const normalizedBody = normalizeToolCallInnerOpenVariants(body, tools);
  const outerNameAttr = getAttributeValue(
    TOOL_CALL_OPEN_RE.exec(markup)?.[0] ?? "",
    "name"
  );
  const toolName =
    extractQwen3CoderToolNameFromMarkup(normalizedBody) ??
    outerNameAttr ??
    null;

  const firstTagStart = normalizedBody.indexOf("<");
  if (
    firstTagStart > 0 &&
    !SALVAGE_MARKUP_ONLY_TEXT_REGEX.test(normalizedBody.slice(0, firstTagStart))
  ) {
    return true;
  }

  let matched = false;
  let cursor = 0;
  XML_TOOL_CALL_CLOSED_CALL_BLOCK_RE.lastIndex = 0;
  for (const match of normalizedBody.matchAll(
    XML_TOOL_CALL_CLOSED_CALL_BLOCK_RE
  )) {
    matched = true;
    const start = match.index ?? 0;
    const before = normalizedBody.slice(cursor, start);
    if (!SALVAGE_MARKUP_ONLY_TEXT_REGEX.test(before)) {
      return true;
    }
    cursor = start + match[0].length;
  }
  if (
    matched &&
    !SALVAGE_MARKUP_ONLY_TEXT_REGEX.test(normalizedBody.slice(cursor))
  ) {
    return true;
  }

  const lastTagEnd = normalizedBody.lastIndexOf(">");
  if (lastTagEnd === -1) {
    return false;
  }
  const trailing = normalizedBody.slice(lastTagEnd + 1);
  if (SALVAGE_MARKUP_ONLY_TEXT_REGEX.test(trailing)) {
    return false;
  }
  const lastTag = lastXmlTagBefore(normalizedBody, lastTagEnd + 1);
  return (
    lastTag === null ||
    lastTag.closing ||
    !isValueTagName(lastTag.name, tools, toolName)
  );
}

function parseToolCallInput(input: string | null | undefined): unknown {
  if (input == null) {
    return {};
  }
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function toQwen3CoderToolParserParamText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function appendQwen3CoderToolParserParameter(
  lines: string[],
  key: string,
  value: unknown
): void {
  const nameAttr = escapeXmlMinimalAttr(key, '"');
  const text = escapeXmlMinimalText(toQwen3CoderToolParserParamText(value));
  lines.push(`    <parameter="${nameAttr}">${text}</parameter>`);
}

function appendQwen3CoderToolParserArgs(lines: string[], args: unknown): void {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const [key, value] of Object.entries(args)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          appendQwen3CoderToolParserParameter(lines, key, item);
        }
      } else {
        appendQwen3CoderToolParserParameter(lines, key, value);
      }
    }
    return;
  }

  if (args !== undefined && args !== null && args !== "") {
    appendQwen3CoderToolParserParameter(lines, "input", args);
  }
}

export const qwen3CoderProtocol = (): TCMProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    return formatToolsWithPromptTemplate({ tools, toolSystemPromptTemplate });
  },

  formatToolCall(toolCall: LanguageModelV4ToolCall): string {
    const args = parseToolCallInput(toolCall.input);
    const lines: string[] = ["<tool_call>"];
    lines.push(
      `  <function="${escapeXmlMinimalAttr(toolCall.toolName, '"')}">`
    );
    appendQwen3CoderToolParserArgs(lines, args);
    lines.push("  </function>");
    lines.push("</tool_call>");
    return lines.join("\n");
  },

  parseGeneratedText({ text, tools, options }) {
    const processedElements: LanguageModelV4Content[] = [];

    const emitToolCalls = (
      calls: Array<{ toolName: string; args: Record<string, unknown> }>
    ) => {
      for (const call of calls) {
        processedElements.push({
          type: "tool-call",
          toolCallId: generateToolCallId(),
          toolName: call.toolName,
          input: stringifyToolInputWithSchema({
            tools,
            toolName: call.toolName,
            args: call.args,
          }),
        });
      }
    };

    const pushText = (value: string) => {
      if (value.length === 0) {
        return;
      }
      processedElements.push({ type: "text", text: value });
    };

    const tryEmitToolCallSegment = (
      segment: string,
      fallbackText: string = segment
    ): boolean => {
      const parsedCalls = parseQwen3CoderToolParserToolCallSegment(
        segment,
        tools
      );
      if (!parsedCalls) {
        options?.onError?.(
          "Could not process Qwen3CoderToolParser XML tool call; keeping original text.",
          {
            toolCall: fallbackText,
            toolName: extractQwen3CoderToolNameFromMarkup(segment),
            toolCallId: generateToolCallId(),
            dropReason: "malformed-tool-call-body",
          }
        );
        processedElements.push({ type: "text", text: fallbackText });
        return false;
      }
      emitToolCalls(parsedCalls);
      return true;
    };

    const emitWrapperlessCallParseFailureAsText = (raw: string) => {
      options?.onError?.(
        "Could not process Qwen3CoderToolParser <function> call; keeping original text.",
        {
          toolCall: raw,
          toolName: extractQwen3CoderToolNameFromMarkup(raw),
          toolCallId: generateToolCallId(),
          dropReason: "malformed-tool-call-body",
        }
      );
      processedElements.push({ type: "text", text: raw });
    };

    const tryParseCallBlocksWithoutWrapperByImplicitStarts = (
      sourceText: string,
      starts: number[]
    ): boolean => {
      let index = 0;
      for (let i = 0; i < starts.length; i += 1) {
        const startIndex = starts[i] ?? -1;
        if (startIndex < 0) {
          continue;
        }
        const endIndex = starts[i + 1] ?? sourceText.length;

        pushText(
          stripTrailingToolCallCloseTags(
            stripLeadingToolCallCloseTags(sourceText.slice(index, startIndex))
          )
        );

        const full = sourceText.slice(startIndex, endIndex);
        const { callContent, trailingText } = splitImplicitCallAndTail(
          full,
          tools
        );
        const parsed = parseSingleFunctionCallXml(callContent, null, tools);
        if (parsed) {
          emitToolCalls([parsed]);
          pushText(
            stripTrailingToolCallCloseTags(
              stripLeadingToolCallCloseTags(trailingText)
            )
          );
        } else {
          emitWrapperlessCallParseFailureAsText(full);
        }

        index = endIndex;
      }

      pushText(
        stripTrailingToolCallCloseTags(
          stripLeadingToolCallCloseTags(sourceText.slice(index))
        )
      );
      return true;
    };

    const tryParseCallBlocksWithoutWrapperByMatches = (
      sourceText: string,
      matches: RegExpMatchArray[]
    ): boolean => {
      let index = 0;
      for (const match of matches) {
        const full = match[0];
        const startIndex = match.index ?? -1;
        if (!full || startIndex < 0) {
          continue;
        }

        pushText(
          stripTrailingToolCallCloseTags(
            stripLeadingToolCallCloseTags(sourceText.slice(index, startIndex))
          )
        );

        const parsed = parseSingleFunctionCallXml(full, null, tools);
        if (parsed) {
          emitToolCalls([parsed]);
        } else {
          emitWrapperlessCallParseFailureAsText(full);
        }
        index = startIndex + full.length;
      }

      const trailing = sourceText.slice(index);
      const trailingStarts = findImplicitCallOpenIndices(
        trailing.toLowerCase()
      );
      if (trailingStarts.length > 0) {
        return tryParseCallBlocksWithoutWrapperByImplicitStarts(
          trailing,
          trailingStarts
        );
      }

      pushText(
        stripTrailingToolCallCloseTags(stripLeadingToolCallCloseTags(trailing))
      );
      return true;
    };

    // vLLM reference (Qwen3CoderToolParser): fallback extraction still attempts to
    // parse when XML wrapper tags are missing (raw output starts with <function=...>).
    // https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3coder_tool_parser.py#L271-L289
    // https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/tests/tool_parsers/test_qwen3coder_tool_parser.py#L356-L377
    const tryParseCallBlocksWithoutWrapperText = (
      sourceText: string
    ): boolean => {
      const matches = Array.from(sourceText.matchAll(CALL_BLOCK_RE));
      if (matches.length > 0) {
        return tryParseCallBlocksWithoutWrapperByMatches(sourceText, matches);
      }

      const starts = findImplicitCallOpenIndices(sourceText.toLowerCase());
      if (starts.length === 0) {
        return false;
      }
      return tryParseCallBlocksWithoutWrapperByImplicitStarts(
        sourceText,
        starts
      );
    };

    const pushTextOrParseWrapperlessCalls = (segment: string) => {
      if (segment.length === 0) {
        return;
      }
      if (!tryParseCallBlocksWithoutWrapperText(segment)) {
        pushText(segment);
      }
    };

    // vLLM reference (Qwen3CoderToolParser): allow trailing, incomplete <tool_call>
    // blocks ("<tool_call>...$"), and still attempt best-effort parsing.
    // https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3coder_tool_parser.py#L55-L61
    const handleCompleteToolCallRemainder = (remainder: string) => {
      if (!remainder) {
        return;
      }
      const lowerRemainder = remainder.toLowerCase();
      const trailingIndex = lowerRemainder.indexOf("<tool_call");
      if (trailingIndex === -1) {
        pushTextOrParseWrapperlessCalls(remainder);
        return;
      }

      pushTextOrParseWrapperlessCalls(remainder.slice(0, trailingIndex));
      const trailing = remainder.slice(trailingIndex);
      const synthetic = TOOL_CALL_CLOSE_RE.test(trailing)
        ? trailing
        : `${trailing}</tool_call>`;
      tryEmitToolCallSegment(synthetic, trailing);
    };

    const tryParseCompleteToolCallBlocks = (): boolean => {
      const matches = Array.from(text.matchAll(TOOL_CALL_BLOCK_RE));
      if (matches.length === 0) {
        return false;
      }

      let index = 0;
      for (const match of matches) {
        const full = match[0];
        const startIndex = match.index ?? -1;
        if (!full || startIndex < 0) {
          continue;
        }

        pushTextOrParseWrapperlessCalls(text.slice(index, startIndex));
        tryEmitToolCallSegment(full);
        index = startIndex + full.length;
      }

      handleCompleteToolCallRemainder(text.slice(index));
      return true;
    };

    const tryParseIncompleteToolCall = (): boolean => {
      const lowerText = text.toLowerCase();
      const startIndex = lowerText.indexOf("<tool_call");
      if (startIndex === -1) {
        return false;
      }

      pushTextOrParseWrapperlessCalls(text.slice(0, startIndex));
      const trailing = text.slice(startIndex);
      const synthetic = TOOL_CALL_CLOSE_RE.test(trailing)
        ? trailing
        : `${trailing}</tool_call>`;
      tryEmitToolCallSegment(synthetic, trailing);
      return true;
    };

    const tryParseCallBlocksWithoutWrapper = (): boolean =>
      tryParseCallBlocksWithoutWrapperText(text);

    const tryParseSingleFunctionCall = (): boolean => {
      const lowerText = text.toLowerCase();
      const startIndex = lowerText.indexOf("<function");
      if (startIndex === -1) {
        return false;
      }

      pushText(stripTrailingToolCallCloseTags(text.slice(0, startIndex)));
      const trailing = stripLeadingToolCallCloseTags(text.slice(startIndex));
      const parsed = parseSingleFunctionCallXml(trailing, null, tools);
      if (!parsed) {
        processedElements.push({ type: "text", text: trailing });
        return true;
      }

      emitToolCalls([parsed]);
      return true;
    };

    if (tryParseCompleteToolCallBlocks()) {
      return processedElements;
    }
    if (tryParseIncompleteToolCall()) {
      return processedElements;
    }
    if (tryParseCallBlocksWithoutWrapper()) {
      return processedElements;
    }
    if (tryParseSingleFunctionCall()) {
      return processedElements;
    }

    return [{ type: "text", text }];
  },

  extractToolCallSegments({ text }) {
    return Array.from(text.matchAll(TOOL_CALL_BLOCK_RE))
      .map((m) => m[0])
      .filter((s): s is string => Boolean(s));
  },

  createStreamParser({ tools, options }) {
    const toolCallStartPrefixLower = "<tool_call";

    // vLLM reference (Qwen3XMLToolParser): streaming tool calls can start directly
    // with <function=...> (missing opening <tool_call>), and the parser implicitly
    // starts a tool_call container.
    // https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3xml_tool_parser.py#L595-L642
    // https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/tests/tool_parsers/test_qwen3coder_tool_parser.py#L901-L922
    const implicitCallPrefixesLower = [
      "<function",
      "<call",
      "<tool",
      "<invoke",
    ];

    type ToolCallMode = "unknown" | "single" | "multi";

    type StreamingCallState = QwenStreamCallState;

    interface ToolCallContainerState {
      activeCall: StreamingCallState | null;
      emittedToolCallCount: number;
      innerBuffer: string;
      mode: ToolCallMode;
      outerNameAttr: string | null;
      outerOpenTag: string;
      raw: string;
    }

    let buffer = "";
    let toolCall: ToolCallContainerState | null = null;
    let implicitCall: StreamingCallState | null = null;
    let implicitCallOpenTag: string | null = null;
    let currentTextId: string | null = null;
    let hasEmittedTextStart = false;

    // Bounded by the tool set: one entry per resolved tool name per stream.
    const schemaParamNameCache = new Map<string, Map<string, string> | null>();
    const getSchemaParamNames = (
      toolName: string | null
    ): Map<string, string> | null => {
      if (!toolName) {
        return null;
      }
      let cached = schemaParamNameCache.get(toolName);
      if (cached === undefined) {
        cached = buildSchemaParamNameMap(toolName, tools);
        schemaParamNameCache.set(toolName, cached);
      }
      return cached;
    };

    const getProgressHoldbackTags = (
      callState: StreamingCallState
    ): string[] => {
      const extra: string[] = [`</${callState.endTagName}>`];
      const schemaParamNames = getSchemaParamNames(callState.toolName);
      if (schemaParamNames) {
        for (const nameLower of schemaParamNames.keys()) {
          extra.push(`<${nameLower}>`, `</${nameLower}>`);
        }
      }
      return extra;
    };

    const flushText = createFlushTextHandler(
      () => currentTextId,
      (id) => {
        currentTextId = id;
      },
      () => hasEmittedTextStart,
      (value) => {
        hasEmittedTextStart = value;
      }
    );

    const maybeEmitToolInputStart = (
      controller: StreamController,
      callState: StreamingCallState
    ) => {
      if (callState.hasEmittedStart) {
        return;
      }
      const toolName = callState.toolName;
      if (!toolName || toolName.trim().length === 0) {
        return;
      }
      flushText(controller);
      controller.enqueue({
        type: "tool-input-start",
        id: callState.toolCallId,
        toolName,
      });
      callState.hasEmittedStart = true;
    };

    const maybeEmitToolInputProgress = (
      controller: StreamController,
      callState: StreamingCallState
    ) => {
      if (!callState.hasEmittedStart) {
        return;
      }
      const toolName = callState.toolName;
      if (!toolName) {
        return;
      }
      const argsForProgress = mergeArgsWithPartialParam(
        callState.args,
        sanitizePartialParamValueForProgress(
          callState.partialParam,
          getProgressHoldbackTags(callState)
        )
      );
      const fullInput = stringifyToolInputWithSchema({
        tools,
        toolName,
        args: argsForProgress,
      });
      if (fullInput === "{}") {
        return;
      }
      emitToolInputProgressDelta({
        controller,
        id: callState.toolCallId,
        state: callState,
        fullInput,
      });
    };

    const finalizeCall = (
      controller: StreamController,
      callState: StreamingCallState,
      fallbackToolName: string | null,
      rawToolCallText: string | null = null
    ): boolean => {
      const resolvedToolName = callState.toolName ?? fallbackToolName;
      if (!resolvedToolName || resolvedToolName.trim().length === 0) {
        const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
        emitFailedToolInputLifecycle({
          controller,
          id: callState.toolCallId,
          endInput: callState.hasEmittedStart,
          emitRawToolCallTextOnError: shouldEmitRaw,
          rawToolCallText,
          emitRawText: (rawText) => {
            flushText(controller, rawText);
          },
        });
        options?.onError?.(
          shouldEmitRaw && rawToolCallText
            ? "Could not resolve Qwen3CoderToolParser tool name for tool call; emitting original text."
            : "Could not resolve Qwen3CoderToolParser tool name for tool call",
          {
            toolCallId: callState.toolCallId,
            toolCall: rawToolCallText,
            toolName: callState.toolName ?? fallbackToolName ?? undefined,
            dropReason: "unresolved-tool-name",
          }
        );
        return false;
      }

      callState.toolName = resolvedToolName;

      maybeEmitToolInputStart(controller, callState);
      maybeEmitToolInputProgress(controller, callState);

      const finalInput = stringifyToolInputWithSchema({
        tools,
        toolName: resolvedToolName,
        args: callState.args,
      });
      emitFinalizedToolInputLifecycle({
        controller,
        id: callState.toolCallId,
        state: callState,
        toolName: resolvedToolName,
        finalInput,
        onMismatch: options?.onError,
      });
      return true;
    };

    const parseStreamingCallContent = (
      controller: StreamController,
      callState: StreamingCallState,
      content: string,
      allowEndOfString: boolean
    ): string =>
      parseCallContent({
        callState,
        content,
        allowEndOfString,
        nameTagRe: QWEN3CODER_TOOL_PARSER_STREAM_NAME_TAG_RE,
        normalizeXmlTextValue,
        parseParamTagAt: (text, lowerText, startIndex, parseOptions) =>
          parseQwen3CoderToolParserParamTagAt(text, lowerText, startIndex, {
            ...parseOptions,
            schemaParamNames: getSchemaParamNames(callState.toolName),
          }),
        mergeParamValue,
        maybeEmitToolInputStart: () => {
          maybeEmitToolInputStart(controller, callState);
        },
        maybeEmitToolInputProgress: () => {
          maybeEmitToolInputProgress(controller, callState);
        },
      });

    // This cache is scoped to createStreamParser (per-stream), so it cannot outlive
    // one stream invocation.
    // It is bounded by the small set of endTagName values {call, function, tool,
    // invoke, tool_call}, so this is effectively ~5 entries max.
    // Eviction is unnecessary because the keyspace is fixed and tiny.
    const closeTagCache = new Map<string, RegExp>();

    const getCloseTagPattern = (endTagName: string): RegExp => {
      const cached = closeTagCache.get(endTagName);
      if (cached) {
        return cached;
      }

      const created = new RegExp(
        `<\\s*\\/\\s*${escapeRegExp(endTagName)}\\s*>`,
        "i"
      );
      closeTagCache.set(endTagName, created);
      return created;
    };

    const getNextCallStartInBuffer = (
      callState: StreamingCallState
    ): number => {
      if (callState.endTagName === "tool_call") {
        return -1;
      }
      const match = QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE.exec(
        callState.buffer
      );
      return match?.index ?? -1;
    };

    const finalizeStreamingCall = (
      controller: StreamController,
      callState: StreamingCallState,
      fallbackToolName: string | null,
      remainder: string
    ) => {
      const rawToolCallText =
        remainder.length > 0 && callState.raw.endsWith(remainder)
          ? callState.raw.slice(0, -remainder.length)
          : callState.raw;
      const ok = finalizeCall(
        controller,
        callState,
        fallbackToolName,
        rawToolCallText
      );
      if (ok && toolCall) {
        toolCall.emittedToolCallCount += 1;
      }
    };

    const consumeCallAtNextBoundary = (
      controller: StreamController,
      callState: StreamingCallState,
      fallbackToolName: string | null,
      nextCallStart: number
    ): { done: true; remainder: string } => {
      const beforeNextCall = callState.buffer.slice(0, nextCallStart);
      const afterNextCall = callState.buffer.slice(nextCallStart);

      callState.buffer = parseStreamingCallContent(
        controller,
        callState,
        beforeNextCall,
        true
      );
      finalizeStreamingCall(
        controller,
        callState,
        fallbackToolName,
        afterNextCall
      );
      return { done: true, remainder: afterNextCall };
    };

    const consumeCall = (
      controller: StreamController,
      callState: StreamingCallState,
      incoming: string,
      fallbackToolName: string | null
    ): { done: boolean; remainder: string } => {
      callState.buffer += incoming;
      callState.raw += incoming;

      const closeMatch = getCloseTagPattern(callState.endTagName).exec(
        callState.buffer
      );
      const closeStart = closeMatch?.index ?? -1;
      const nextCallStart = getNextCallStartInBuffer(callState);
      const shouldCloseAtNextBoundary =
        nextCallStart !== -1 &&
        (closeStart === -1 || nextCallStart < closeStart);

      if (shouldCloseAtNextBoundary) {
        return consumeCallAtNextBoundary(
          controller,
          callState,
          fallbackToolName,
          nextCallStart
        );
      }

      if (!closeMatch) {
        callState.buffer = parseStreamingCallContent(
          controller,
          callState,
          callState.buffer,
          false
        );
        return { done: false, remainder: "" };
      }

      const closeEnd = closeStart + (closeMatch[0]?.length ?? 0);
      const beforeClose = callState.buffer.slice(0, closeStart);
      const afterClose = callState.buffer.slice(closeEnd);

      parseStreamingCallContent(controller, callState, beforeClose, true);
      callState.buffer = "";
      finalizeStreamingCall(
        controller,
        callState,
        fallbackToolName,
        afterClose
      );
      return { done: true, remainder: afterClose };
    };

    const finalizeCallAtFinish = (
      controller: StreamController,
      callState: StreamingCallState,
      fallbackToolName: string | null
    ): { ok: boolean; trailingText: string } => {
      callState.buffer = parseStreamingCallContent(
        controller,
        callState,
        callState.buffer,
        true
      );
      const trailingText = stripLeadingCallCloseTags(callState.buffer);
      callState.buffer = "";
      const ok = finalizeCall(controller, callState, fallbackToolName, null);
      return {
        ok,
        trailingText,
      };
    };

    const flushSafeTextPrefix = (controller: StreamController) => {
      const lower = buffer.toLowerCase();

      const potentialIndices = [
        getPotentialTagStartIndex(lower, toolCallStartPrefixLower),
        ...implicitCallPrefixesLower.map((prefix) =>
          getPotentialTagStartIndex(lower, prefix)
        ),
      ].filter((value): value is number => value != null);

      const potentialIndex =
        potentialIndices.length > 0 ? Math.min(...potentialIndices) : null;
      if (potentialIndex == null) {
        if (buffer.length > 0) {
          flushText(controller, buffer);
          buffer = "";
        }
        return;
      }

      if (potentialIndex > 0) {
        flushText(controller, buffer.slice(0, potentialIndex));
        buffer = buffer.slice(potentialIndex);
      }
    };

    const stripLeadingToolCallCloseTagsFromBuffer = () => {
      if (!buffer) {
        return;
      }
      const stripped = stripLeadingToolCallCloseTags(buffer);
      if (stripped !== buffer) {
        buffer = stripped;
      }
    };

    const startToolCallIfPresent = () => {
      if (toolCall) {
        return;
      }

      if (implicitCall) {
        return;
      }

      const lower = buffer.toLowerCase();
      const startIndex = getPotentialStartIndex(
        lower,
        toolCallStartPrefixLower
      );
      if (startIndex == null || startIndex !== 0) {
        return;
      }

      const gtIndex = buffer.indexOf(">");
      if (gtIndex === -1) {
        return;
      }

      const openTag = buffer.slice(0, gtIndex + 1);
      if (!TOOL_CALL_OPEN_RE.test(openTag)) {
        return;
      }

      toolCall = {
        outerOpenTag: openTag,
        outerNameAttr: getAttributeValue(openTag, "name"),
        raw: openTag,
        mode: "unknown",
        innerBuffer: "",
        activeCall: null,
        emittedToolCallCount: 0,
      };

      const remainder = buffer.slice(gtIndex + 1);
      buffer = "";
      if (remainder.length > 0) {
        toolCall.raw += remainder;
        toolCall.innerBuffer += remainder;
      }
    };

    const startImplicitCallIfPresent = (controller: StreamController) => {
      if (toolCall || implicitCall) {
        return;
      }

      const match = QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE.exec(buffer);
      const startIndex = match?.index ?? -1;
      const openTag = match?.[0] ?? "";
      const callTagName = (match?.[1] ?? "").toLowerCase();
      if (!match || startIndex !== 0 || !openTag || !callTagName) {
        return;
      }

      const inlineToolName =
        getAttributeValue(openTag, "name") ?? getShorthandValue(openTag);
      if (!inlineToolName || inlineToolName.trim().length === 0) {
        return;
      }
      const selfClosing =
        QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE.test(openTag);

      buffer = buffer.slice(openTag.length);

      const newCall: StreamingCallState = {
        endTagName: callTagName,
        toolCallId: generateToolCallId(),
        toolName: inlineToolName,
        hasEmittedStart: false,
        partialParam: null,
        emittedInput: "",
        raw: openTag,
        args: {},
        buffer: "",
      };

      maybeEmitToolInputStart(controller, newCall);

      if (selfClosing) {
        finalizeCall(controller, newCall, inlineToolName, newCall.raw);
        return;
      }

      implicitCall = newCall;
      implicitCallOpenTag = openTag;
    };

    const processImplicitCall = (controller: StreamController) => {
      while (implicitCall) {
        const callState = implicitCall;
        const { done, remainder } = consumeCall(
          controller,
          callState,
          buffer,
          null
        );
        buffer = "";
        if (!done) {
          return;
        }

        implicitCall = null;
        implicitCallOpenTag = null;
        if (remainder.length > 0) {
          buffer = remainder;
        }

        stripLeadingToolCallCloseTagsFromBuffer();
        flushSafeTextPrefix(controller);
        startToolCallIfPresent();
        if (toolCall) {
          processToolCall(controller);
          return;
        }
        startImplicitCallIfPresent(controller);
      }
    };

    const drainStarts = (controller: StreamController) => {
      while (true) {
        if (toolCall || implicitCall) {
          return;
        }

        const before = buffer;
        startToolCallIfPresent();
        if (toolCall) {
          processToolCall(controller);
          return;
        }

        startImplicitCallIfPresent(controller);
        if (implicitCall) {
          processImplicitCall(controller);
          return;
        }

        if (buffer === before) {
          return;
        }
        stripLeadingToolCallCloseTagsFromBuffer();
        flushSafeTextPrefix(controller);
      }
    };

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Stream tool-call parsing is a nested state machine.
    const processToolCall = (controller: StreamController) => {
      while (toolCall) {
        if (toolCall.mode === "unknown") {
          const normalization = normalizeStreamToolCallInnerOpenVariants(
            toolCall.innerBuffer,
            tools
          );
          if (normalization.status === "incomplete") {
            return;
          }
          if (normalization.status === "rewritten") {
            toolCall.innerBuffer = normalization.value;
          }
          const callMatch =
            QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE.exec(
              toolCall.innerBuffer
            );
          const signalMatch =
            QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE.exec(
              toolCall.innerBuffer
            );
          if (
            callMatch &&
            (!signalMatch || (callMatch.index ?? 0) < (signalMatch.index ?? 0))
          ) {
            toolCall.mode = "multi";
          } else if (signalMatch) {
            toolCall.mode = "single";
            const activeCall: StreamingCallState = {
              endTagName: "tool_call",
              toolCallId: generateToolCallId(),
              toolName: toolCall.outerNameAttr,
              hasEmittedStart: false,
              partialParam: null,
              emittedInput: "",
              raw: toolCall.outerOpenTag,
              args: {},
              buffer: "",
            };
            toolCall.activeCall = activeCall;
            if (toolCall.outerNameAttr) {
              maybeEmitToolInputStart(controller, activeCall);
            }
          } else {
            return;
          }
        }

        if (toolCall.mode === "single") {
          const callState = toolCall.activeCall;
          if (!callState) {
            return;
          }

          const { done, remainder } = consumeCall(
            controller,
            callState,
            toolCall.innerBuffer,
            toolCall.outerNameAttr
          );
          toolCall.innerBuffer = "";

          if (!done) {
            return;
          }

          toolCall = null;
          if (remainder.length > 0) {
            buffer = remainder + buffer;
          }
          flushSafeTextPrefix(controller);
          startToolCallIfPresent();
          continue;
        }

        if (toolCall.mode === "multi") {
          if (toolCall.activeCall) {
            const callState = toolCall.activeCall;
            const { done, remainder } = consumeCall(
              controller,
              callState,
              toolCall.innerBuffer,
              toolCall.outerNameAttr
            );
            toolCall.innerBuffer = "";

            if (!done) {
              return;
            }

            toolCall.activeCall = null;
            toolCall.innerBuffer = remainder;
            continue;
          }

          const closeMatch =
            QWEN3CODER_TOOL_PARSER_STREAM_TOOL_CALL_CLOSE_TAG_RE.exec(
              toolCall.innerBuffer
            );
          const callOpenMatch =
            QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_TAG_RE.exec(
              toolCall.innerBuffer
            );

          if (!(closeMatch || callOpenMatch)) {
            return;
          }

          const closeIndex = closeMatch?.index ?? -1;
          const callIndex = callOpenMatch?.index ?? -1;
          const hasClose = closeIndex !== -1;
          const hasCall = callIndex !== -1;

          const chooseClose = hasClose && (!hasCall || closeIndex < callIndex);
          const nextIndex = chooseClose ? closeIndex : callIndex;
          if (nextIndex > 0) {
            toolCall.innerBuffer = toolCall.innerBuffer.slice(nextIndex);
          }

          if (chooseClose) {
            const matchLen = closeMatch?.[0]?.length ?? 0;
            const remainder = toolCall.innerBuffer.slice(matchLen);
            toolCall = null;
            if (remainder.length > 0) {
              buffer = remainder + buffer;
            }
            flushSafeTextPrefix(controller);
            startToolCallIfPresent();
            continue;
          }

          if (!callOpenMatch) {
            return;
          }

          const openTag = callOpenMatch[0] ?? "";
          const callTagName = (callOpenMatch[1] ?? "").toLowerCase();
          const rest = toolCall.innerBuffer.slice(openTag.length);

          const selfClosing =
            QWEN3CODER_TOOL_PARSER_STREAM_SELF_CLOSING_TAG_RE.test(openTag);
          if (selfClosing) {
            const toolNameAttr =
              getAttributeValue(openTag, "name") ??
              getShorthandValue(openTag) ??
              toolCall.outerNameAttr;
            const immediateCall: StreamingCallState = {
              endTagName: callTagName,
              toolCallId: generateToolCallId(),
              toolName: toolNameAttr,
              hasEmittedStart: false,
              partialParam: null,
              emittedInput: "",
              raw: openTag,
              args: {},
              buffer: "",
            };
            const ok = finalizeCall(
              controller,
              immediateCall,
              toolNameAttr,
              immediateCall.raw
            );
            if (ok) {
              toolCall.emittedToolCallCount += 1;
            }
            toolCall.innerBuffer = rest;
            continue;
          }

          const toolNameAttr =
            getAttributeValue(openTag, "name") ?? getShorthandValue(openTag);
          const newCall: StreamingCallState = {
            endTagName: callTagName,
            toolCallId: generateToolCallId(),
            toolName: toolNameAttr,
            hasEmittedStart: false,
            partialParam: null,
            emittedInput: "",
            raw: openTag,
            args: {},
            buffer: "",
          };

          if (toolNameAttr) {
            maybeEmitToolInputStart(controller, newCall);
          }

          toolCall.activeCall = newCall;
          toolCall.innerBuffer = rest;
        }
      }
    };

    /**
     * Cross-format salvage before dropping an unfinished tool_call block:
     * some models emit Hermes-style JSON payloads inside `<tool_call>` tags
     * regardless of the Qwen prompt (observed live on LiquidAI LFM2). The
     * shared recovery only fires when the block is nothing but resolvable
     * payloads plus markup remnants.
     */
    const trySalvageForeignFormatCalls = (
      controller: StreamController,
      rawToolCall: string
    ): boolean => {
      const recovered = recoverToolCallFromJsonCandidates(rawToolCall, tools);
      if (!recovered) {
        return false;
      }
      const calls = recovered.filter(
        (part): part is Extract<typeof part, { type: "tool-call" }> =>
          part.type === "tool-call"
      );
      const hasProse = recovered.some(
        (part) =>
          part.type === "text" &&
          !SALVAGE_MARKUP_ONLY_TEXT_REGEX.test(part.text)
      );
      if (calls.length === 0 || hasProse) {
        return false;
      }
      for (const call of calls) {
        controller.enqueue({
          type: "tool-input-start",
          id: call.toolCallId,
          toolName: call.toolName,
        });
        if (call.input.length > 0) {
          controller.enqueue({
            type: "tool-input-delta",
            id: call.toolCallId,
            delta: call.input,
          });
        }
        controller.enqueue({ type: "tool-input-end", id: call.toolCallId });
        controller.enqueue(call);
      }
      return true;
    };

    /**
     * Finish-time backstop: re-run the (variant-tolerant) generate-path parser
     * over the buffered tool_call markup before dropping it. This recovers
     * shapes the incremental state machine cannot stream, e.g. GLM-4.7's
     * `<tool_call>write_file` + schema-property parameter tags.
     */
    const trySalvageXmlToolCallAtFinish = (
      controller: StreamController,
      rawToolCall: string
    ): boolean => {
      const synthetic = TOOL_CALL_CLOSE_RE.test(rawToolCall)
        ? rawToolCall
        : `${rawToolCall}</tool_call>`;
      if (hasProseOutsideXmlCalls(synthetic, tools)) {
        return false;
      }
      const calls = parseQwen3CoderToolParserToolCallSegment(synthetic, tools);
      if (!calls || calls.length === 0) {
        return false;
      }
      for (const call of calls) {
        const toolCallId = generateToolCallId();
        const input = stringifyToolInputWithSchema({
          tools,
          toolName: call.toolName,
          args: call.args,
        });
        controller.enqueue({
          type: "tool-input-start",
          id: toolCallId,
          toolName: call.toolName,
        });
        if (input.length > 0) {
          controller.enqueue({
            type: "tool-input-delta",
            id: toolCallId,
            delta: input,
          });
        }
        enqueueToolInputEndAndCall({
          controller,
          id: toolCallId,
          toolName: call.toolName,
          input,
        });
      }
      return true;
    };

    const reportUnfinishedToolCallAtFinish = (
      controller: StreamController,
      rawToolCall: string,
      metadata: { toolCallId?: string; toolName?: string | null } = {}
    ) => {
      if (trySalvageXmlToolCallAtFinish(controller, rawToolCall)) {
        return;
      }
      if (trySalvageForeignFormatCalls(controller, rawToolCall)) {
        return;
      }
      const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
      const toolName =
        metadata.toolName ?? extractShorthandToolNameFromRaw(rawToolCall);
      options?.onError?.(
        shouldEmitRaw
          ? "Could not complete streaming Qwen3CoderToolParser XML tool call at finish; emitting original text."
          : "Could not complete streaming Qwen3CoderToolParser XML tool call at finish.",
        {
          toolCall: rawToolCall,
          ...(metadata.toolCallId ? { toolCallId: metadata.toolCallId } : {}),
          ...(toolName ? { toolName } : {}),
          dropReason: "unfinished-tool-call",
        }
      );
      if (shouldEmitRaw) {
        flushText(controller, rawToolCall);
      }
    };

    const reportUnfinishedImplicitCallAtFinish = (
      controller: StreamController,
      rawCallText: string,
      callState: StreamingCallState
    ) => {
      const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
      options?.onError?.(
        shouldEmitRaw
          ? "Could not complete streaming Qwen3CoderToolParser call block at finish; emitting original text."
          : "Could not complete streaming Qwen3CoderToolParser call block at finish.",
        {
          toolCall: rawCallText,
          toolCallId: callState.toolCallId,
          ...(callState.toolName ? { toolName: callState.toolName } : {}),
          dropReason: "unfinished-tool-call",
        }
      );
      if (shouldEmitRaw) {
        flushText(controller, rawCallText);
      }
    };

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Stream finish reconciliation is a best-effort state machine cleanup.
    const handleFinish = (controller: StreamController) => {
      if (toolCall) {
        // Process any remaining complete structures first.
        processToolCall(controller);

        if (toolCall) {
          // Best-effort reconciliation on incomplete tool-call markup at finish.
          if (toolCall.mode === "unknown") {
            // The stream is over, so force malformed-opener normalization even
            // when the live path deferred it as potentially incomplete.
            toolCall.innerBuffer = normalizeToolCallInnerOpenVariants(
              toolCall.innerBuffer,
              tools
            );
            const callMatch =
              QWEN3CODER_TOOL_PARSER_STREAM_CALL_OPEN_START_RE.exec(
                toolCall.innerBuffer
              );
            const signalMatch =
              QWEN3CODER_TOOL_PARSER_STREAM_NAME_OR_PARAM_SIGNAL_RE.exec(
                toolCall.innerBuffer
              );
            if (
              callMatch &&
              (!signalMatch ||
                (callMatch.index ?? 0) < (signalMatch.index ?? 0))
            ) {
              toolCall.mode = "multi";
            } else if (signalMatch) {
              toolCall.mode = "single";
              toolCall.activeCall = {
                endTagName: "tool_call",
                toolCallId: generateToolCallId(),
                toolName: toolCall.outerNameAttr,
                hasEmittedStart: false,
                partialParam: null,
                emittedInput: "",
                raw: toolCall.outerOpenTag,
                args: {},
                buffer: "",
              };
            }
          }

          if (toolCall.mode === "single" && toolCall.activeCall) {
            toolCall.activeCall.buffer += toolCall.innerBuffer;
            toolCall.innerBuffer = "";
            const result = finalizeCallAtFinish(
              controller,
              toolCall.activeCall,
              toolCall.outerNameAttr
            );
            if (result.ok) {
              toolCall.emittedToolCallCount += 1;
            }
            const shouldFlushTrailingText =
              result.ok || !shouldEmitRawToolCallTextOnError(options);
            if (shouldFlushTrailingText && result.trailingText.length > 0) {
              flushText(controller, result.trailingText);
            }
            if (!result.ok && toolCall.emittedToolCallCount === 0) {
              reportUnfinishedToolCallAtFinish(controller, toolCall.raw, {
                toolCallId: toolCall.activeCall.toolCallId,
                ...(toolCall.activeCall.toolName
                  ? { toolName: toolCall.activeCall.toolName }
                  : {}),
              });
            }
          } else if (toolCall.mode === "multi") {
            if (toolCall.activeCall) {
              const result = finalizeCallAtFinish(
                controller,
                toolCall.activeCall,
                toolCall.outerNameAttr
              );
              if (result.ok) {
                toolCall.emittedToolCallCount += 1;
              }
              const shouldFlushTrailingText =
                result.ok || !shouldEmitRawToolCallTextOnError(options);
              if (shouldFlushTrailingText && result.trailingText.length > 0) {
                flushText(controller, result.trailingText);
              }
              if (!result.ok && toolCall.emittedToolCallCount === 0) {
                reportUnfinishedToolCallAtFinish(controller, toolCall.raw, {
                  toolCallId: toolCall.activeCall.toolCallId,
                  ...(toolCall.activeCall.toolName
                    ? { toolName: toolCall.activeCall.toolName }
                    : {}),
                });
              }
              toolCall.activeCall = null;
            } else if (toolCall.emittedToolCallCount === 0) {
              reportUnfinishedToolCallAtFinish(controller, toolCall.raw, {
                toolName: toolCall.outerNameAttr,
              });
            }
          } else {
            reportUnfinishedToolCallAtFinish(controller, toolCall.raw, {
              toolName: toolCall.outerNameAttr,
            });
          }

          toolCall = null;
        }
      }

      if (implicitCall) {
        const callState = implicitCall;
        const openTag = implicitCallOpenTag;
        implicitCall = null;
        implicitCallOpenTag = null;

        const result = finalizeCallAtFinish(controller, callState, null);
        const shouldFlushTrailingText =
          result.ok || !shouldEmitRawToolCallTextOnError(options);
        if (shouldFlushTrailingText && result.trailingText.length > 0) {
          flushText(controller, result.trailingText);
        }
        if (!result.ok && openTag) {
          reportUnfinishedImplicitCallAtFinish(
            controller,
            callState.raw || openTag + callState.buffer,
            callState
          );
        }
      } else {
        stripLeadingToolCallCloseTagsFromBuffer();
        flushSafeTextPrefix(controller);
        drainStarts(controller);
      }

      if (buffer.length > 0) {
        flushText(controller, buffer);
        buffer = "";
      }

      flushText(controller);
    };

    const handlePassthroughChunk = (
      controller: StreamController,
      chunk: LanguageModelV4StreamPart
    ) => {
      if (!toolCall && buffer) {
        flushText(controller, buffer);
        buffer = "";
      }
      controller.enqueue(chunk);
    };

    const handleTextDeltaChunk = (
      controller: StreamController,
      delta: string
    ) => {
      if (toolCall) {
        toolCall.raw += delta;
        toolCall.innerBuffer += delta;
        processToolCall(controller);
        return;
      }

      if (implicitCall) {
        const callState = implicitCall;
        const { done, remainder } = consumeCall(
          controller,
          callState,
          delta,
          null
        );
        if (!done) {
          return;
        }
        implicitCall = null;
        implicitCallOpenTag = null;
        if (remainder.length > 0) {
          buffer = remainder + buffer;
        }
        stripLeadingToolCallCloseTagsFromBuffer();
        flushSafeTextPrefix(controller);
        drainStarts(controller);
        return;
      }

      buffer += delta;
      stripLeadingToolCallCloseTagsFromBuffer();
      flushSafeTextPrefix(controller);
      drainStarts(controller);
    };

    const handleTransformChunk = (
      controller: StreamController,
      chunk: LanguageModelV4StreamPart
    ) => {
      if (chunk.type === "finish") {
        handleFinish(controller);
        controller.enqueue(chunk);
        return;
      }
      // The parser re-segments text under its own synthetic ids (tool-call
      // markup is excised), so the provider's original text-start/text-end
      // envelopes are dropped instead of producing empty duplicate blocks.
      if (chunk.type === "text-start" || chunk.type === "text-end") {
        return;
      }

      if (chunk.type !== "text-delta") {
        handlePassthroughChunk(controller, chunk);
        return;
      }
      const delta = chunk.delta;
      if (!delta) {
        return;
      }
      handleTextDeltaChunk(controller, delta);
    };

    return new TransformStream({
      transform(chunk, controller) {
        handleTransformChunk(controller, chunk);
      },
      flush(controller) {
        handleFinish(controller);
      },
    });
  },
});

export const uiTarsXmlProtocol = qwen3CoderProtocol;

export const Qwen3CoderToolParser = qwen3CoderProtocol;
