import type {
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider";
import {
  escapeXmlMinimalAttr,
  escapeXmlMinimalText,
  unescapeXml,
} from "../../rxml/utils/helpers";
import { getPotentialStartIndex } from "../utils/get-potential-start-index";
import { generateToolCallId } from "../utils/id";
import { createFlushTextHandler } from "../utils/protocol-utils";
import { escapeRegExp } from "../utils/regex";
import {
  emitFinalRemainder,
  emitPrefixDelta,
  toIncompleteJsonPrefix,
} from "../utils/streamed-tool-input-delta";
import type { ParserOptions, TCMProtocol } from "./protocol-interface";

function shouldEmitRawToolCallTextOnError(options?: ParserOptions): boolean {
  return options?.emitRawToolCallTextOnError === true;
}

const TOOL_CALL_OPEN_RE = /<tool_call\b[^>]*>/i;
const TOOL_CALL_CLOSE_RE = /<\/tool_call\s*>/i;
const TOOL_CALL_BLOCK_RE = /<tool_call\b[^>]*>[\s\S]*?<\/tool_call\s*>/gi;

const CALL_BLOCK_RE = /<(call|function|tool|invoke)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

const PARAM_TAG_RE =
  /<(parameter|param|argument|arg)\b[^>]*\bname\s*=\s*(["'])(.*?)\2[^>]*>([\s\S]*?)<\/\1\s*>/gi;

const PARAM_SELF_CLOSING_RE =
  /<(parameter|param|argument|arg)\b[^>]*\bname\s*=\s*(["'])(.*?)\2[^>]*\/\s*>/gi;

// Non-global variants for streaming parsing (avoids `lastIndex` state).
const UI_TARS_STREAM_CALL_OPEN_START_RE =
  /<\s*(?!\/)\s*(call|function|tool|invoke)\b/i;
const UI_TARS_STREAM_CALL_OPEN_TAG_RE =
  /<\s*(?!\/)\s*(call|function|tool|invoke)\b[^>]*>/i;
const UI_TARS_STREAM_TOOL_CALL_CLOSE_TAG_RE = /<\s*\/\s*tool_call\s*>/i;
const UI_TARS_STREAM_NAME_OR_PARAM_SIGNAL_RE =
  /<\s*(?!\/)\s*(name|tool_name|parameter|param|argument|arg)\b/i;
const UI_TARS_STREAM_NAME_TAG_RE =
  /<\s*(name|tool_name)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/i;
const UI_TARS_STREAM_PARAM_TAG_RE =
  /<(parameter|param|argument|arg)\b[^>]*\bname\s*=\s*(["'])(.*?)\2[^>]*>([\s\S]*?)<\/\1\s*>/i;
const UI_TARS_STREAM_PARAM_SELF_CLOSING_RE =
  /<(parameter|param|argument|arg)\b[^>]*\bname\s*=\s*(["'])(.*?)\2[^>]*\/\s*>/i;
const UI_TARS_STREAM_PARAM_OPEN_TAG_RE =
  /<\s*(parameter|param|argument|arg)\b[^>]*\bname\s*=\s*(["'])(.*?)\2[^>]*>/i;
const UI_TARS_STREAM_SELF_CLOSING_TAG_RE = /\/\s*>$/;

function normalizeXmlTextValue(raw: string): string {
  let out = raw.trim();
  if (out.startsWith("<![CDATA[") && out.endsWith("]]>")) {
    out = out.slice("<![CDATA[".length, -"]]>".length).trim();
  }
  return unescapeXml(out);
}

function getOpeningTag(xml: string): string | null {
  const gt = xml.indexOf(">");
  if (gt === -1) {
    return null;
  }
  return xml.slice(0, gt + 1);
}

function getAttributeValue(openTag: string, attrName: string): string | null {
  const re = new RegExp(
    `\\b${escapeRegExp(attrName)}\\s*=\\s*(["'])([\\s\\S]*?)\\1`,
    "i"
  );
  const match = re.exec(openTag);
  if (!match) {
    return null;
  }
  return unescapeXml(match[2] ?? "");
}

function extractFirstTagText(xml: string, tagName: string): string | null {
  const re = new RegExp(
    `<\\s*${escapeRegExp(tagName)}\\b[^>]*>([\\s\\S]*?)<\\s*\\/\\s*${escapeRegExp(tagName)}\\s*>`,
    "i"
  );
  const match = re.exec(xml);
  if (!match) {
    return null;
  }
  return normalizeXmlTextValue(match[1] ?? "");
}

function extractToolCallInnerXml(segment: string): {
  inner: string;
  outerOpenTag: string;
} | null {
  const openMatch = TOOL_CALL_OPEN_RE.exec(segment);
  const closeMatch = TOOL_CALL_CLOSE_RE.exec(segment);
  if (!(openMatch && closeMatch)) {
    return null;
  }

  const openIndex = openMatch.index;
  const openTag = openMatch[0];
  const openEnd = openIndex + openTag.length;

  // Prefer the last closing tag to avoid early matches if nested content
  // includes a literal "</tool_call>" string.
  const closeIndex = segment.toLowerCase().lastIndexOf("</tool_call");
  if (closeIndex === -1) {
    return null;
  }
  const closeGt = segment.indexOf(">", closeIndex);
  if (closeGt === -1) {
    return null;
  }

  return {
    outerOpenTag: openTag,
    inner: segment.slice(openEnd, closeIndex),
  };
}

function mergeParamValue(
  args: Record<string, unknown>,
  key: string,
  value: string
): void {
  const existing = args[key];
  if (existing === undefined) {
    args[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  args[key] = [existing, value];
}

function extractParameters(xml: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};

  for (const match of xml.matchAll(PARAM_TAG_RE)) {
    const name = match[3];
    const rawValue = match[4] ?? "";
    if (!name) {
      continue;
    }
    mergeParamValue(args, unescapeXml(name), normalizeXmlTextValue(rawValue));
  }

  for (const match of xml.matchAll(PARAM_SELF_CLOSING_RE)) {
    const name = match[3];
    if (!name) {
      continue;
    }
    mergeParamValue(args, unescapeXml(name), "");
  }

  return args;
}

function parseSingleFunctionCallXml(
  xml: string,
  fallbackToolName: string | null
): { toolName: string; args: Record<string, unknown> } | null {
  const openingTag = getOpeningTag(xml);
  const toolNameAttr = openingTag
    ? getAttributeValue(openingTag, "name")
    : null;
  const toolName =
    toolNameAttr ??
    extractFirstTagText(xml, "name") ??
    extractFirstTagText(xml, "tool_name") ??
    fallbackToolName;

  if (!toolName || toolName.trim().length === 0) {
    return null;
  }

  return {
    toolName,
    args: extractParameters(xml),
  };
}

function parseUiTarsToolCallSegment(
  segment: string
): Array<{ toolName: string; args: Record<string, unknown> }> | null {
  const extracted = extractToolCallInnerXml(segment);
  if (!extracted) {
    return null;
  }

  const { inner, outerOpenTag } = extracted;
  const outerNameAttr = getAttributeValue(outerOpenTag, "name");

  const callBlocks = Array.from(inner.matchAll(CALL_BLOCK_RE)).map(
    (m) => m[0] ?? ""
  );

  if (callBlocks.length > 0) {
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> =
      [];
    for (const callBlock of callBlocks) {
      const parsed = parseSingleFunctionCallXml(callBlock, outerNameAttr);
      if (!parsed) {
        return null;
      }
      calls.push(parsed);
    }
    return calls;
  }

  const single = parseSingleFunctionCallXml(segment, outerNameAttr);
  if (!single) {
    return null;
  }
  return [single];
}

type StreamController =
  TransformStreamDefaultController<LanguageModelV3StreamPart>;

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

function toUiTarsParamText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function appendUiTarsParameter(
  lines: string[],
  key: string,
  value: unknown
): void {
  const nameAttr = escapeXmlMinimalAttr(key, '"');
  const text = escapeXmlMinimalText(toUiTarsParamText(value));
  lines.push(`  <parameter name="${nameAttr}">${text}</parameter>`);
}

function appendUiTarsArgs(lines: string[], args: unknown): void {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const [key, value] of Object.entries(args)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          appendUiTarsParameter(lines, key, item);
        }
      } else {
        appendUiTarsParameter(lines, key, value);
      }
    }
    return;
  }

  if (args !== undefined && args !== null && args !== "") {
    appendUiTarsParameter(lines, "input", args);
  }
}

export const uiTarsXmlProtocol = (): TCMProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    return toolSystemPromptTemplate(tools || []);
  },

  formatToolCall(toolCall: LanguageModelV3ToolCall): string {
    const args = parseToolCallInput(toolCall.input);
    const lines: string[] = ["<tool_call>"];
    lines.push(`  <name>${escapeXmlMinimalText(toolCall.toolName)}</name>`);
    appendUiTarsArgs(lines, args);

    lines.push("</tool_call>");
    return lines.join("\n");
  },

  parseGeneratedText({ text, tools: _tools, options }) {
    const processedElements: LanguageModelV3Content[] = [];
    let currentIndex = 0;

    for (const match of text.matchAll(TOOL_CALL_BLOCK_RE)) {
      const full = match[0];
      const startIndex = match.index ?? -1;
      if (!full || startIndex < 0) {
        continue;
      }

      if (startIndex > currentIndex) {
        processedElements.push({
          type: "text",
          text: text.slice(currentIndex, startIndex),
        });
      }

      const parsedCalls = parseUiTarsToolCallSegment(full);
      if (!parsedCalls) {
        options?.onError?.(
          "Could not process UI-TARS XML tool call; keeping original text.",
          { toolCall: full }
        );
        processedElements.push({ type: "text", text: full });
        currentIndex = startIndex + full.length;
        continue;
      }

      for (const call of parsedCalls) {
        processedElements.push({
          type: "tool-call",
          toolCallId: generateToolCallId(),
          toolName: call.toolName,
          input: JSON.stringify(call.args),
        });
      }

      currentIndex = startIndex + full.length;
    }

    if (currentIndex < text.length) {
      processedElements.push({ type: "text", text: text.slice(currentIndex) });
    }

    return processedElements;
  },

  extractToolCallSegments({ text }) {
    return Array.from(text.matchAll(TOOL_CALL_BLOCK_RE))
      .map((m) => m[0])
      .filter((s): s is string => Boolean(s));
  },

  createStreamParser({ tools: _tools, options }) {
    const toolCallStartPrefixLower = "<tool_call";

    type ToolCallMode = "unknown" | "single" | "multi";

    interface StreamingCallState {
      endTagName: string;
      toolCallId: string;
      toolName: string | null;
      hasEmittedStart: boolean;
      emittedInput: string;
      args: Record<string, unknown>;
      pendingParamName: string | null;
      pendingParamValues: string[];
      pendingParamIsArray: boolean;
      buffer: string;
      sealedKeys: Set<string>;
    }

    interface ToolCallContainerState {
      outerOpenTag: string;
      outerNameAttr: string | null;
      raw: string;
      mode: ToolCallMode;
      innerBuffer: string;
      activeCall: StreamingCallState | null;
      emittedToolCallCount: number;
    }

    let buffer = "";
    let toolCall: ToolCallContainerState | null = null;
    let currentTextId: string | null = null;
    let hasEmittedTextStart = false;

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

    const removeSlice = (text: string, start: number, end: number): string =>
      text.slice(0, start) + text.slice(end);

    const findNextParamTag = (
      text: string
    ): { start: number; end: number; name: string; value: string } | null => {
      const tagMatch = UI_TARS_STREAM_PARAM_TAG_RE.exec(text);
      const selfMatch = UI_TARS_STREAM_PARAM_SELF_CLOSING_RE.exec(text);

      if (!(tagMatch || selfMatch)) {
        return null;
      }

      const tagIndex = tagMatch?.index ?? Number.POSITIVE_INFINITY;
      const selfIndex = selfMatch?.index ?? Number.POSITIVE_INFINITY;
      const useTag = tagIndex <= selfIndex;
      const match = (useTag ? tagMatch : selfMatch) as RegExpExecArray;

      const start = match.index ?? 0;
      const full = match[0] ?? "";
      const end = start + full.length;
      const name = unescapeXml(match[3] ?? "");
      const value = useTag ? normalizeXmlTextValue(match[4] ?? "") : "";
      return { start, end, name, value };
    };

    const peekNextParamName = (text: string): string | null => {
      const match = UI_TARS_STREAM_PARAM_OPEN_TAG_RE.exec(text);
      if (!match) {
        return null;
      }
      const name = match[3] ?? "";
      if (!name) {
        return null;
      }
      return unescapeXml(name);
    };

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
      const fullInput = JSON.stringify(callState.args);
      if (fullInput === "{}") {
        return;
      }
      const prefixCandidate = toIncompleteJsonPrefix(fullInput);
      emitPrefixDelta({
        controller,
        id: callState.toolCallId,
        state: callState,
        candidate: prefixCandidate,
      });
    };

    const flushPendingIfPossible = (
      controller: StreamController,
      callState: StreamingCallState,
      lookaheadText: string
    ) => {
      const pendingName = callState.pendingParamName;
      if (!pendingName || pendingName.trim().length === 0) {
        return;
      }
      if (callState.pendingParamIsArray) {
        const next = peekNextParamName(lookaheadText);
        if (next && next !== pendingName) {
          callState.sealedKeys.add(pendingName);
          callState.pendingParamName = null;
          callState.pendingParamValues = [];
          callState.pendingParamIsArray = false;
        }
        return;
      }

      const nextName = peekNextParamName(lookaheadText);
      if (!nextName) {
        return;
      }

      if (nextName === pendingName) {
        callState.pendingParamIsArray = true;
        callState.args[pendingName] = [callState.pendingParamValues[0] ?? ""];
        maybeEmitToolInputProgress(controller, callState);
        return;
      }

      callState.args[pendingName] = callState.pendingParamValues[0] ?? "";
      callState.sealedKeys.add(pendingName);
      callState.pendingParamName = null;
      callState.pendingParamValues = [];
      callState.pendingParamIsArray = false;
      maybeEmitToolInputProgress(controller, callState);
    };

    const startPendingParam = (
      callState: StreamingCallState,
      key: string,
      value: string
    ) => {
      callState.pendingParamName = key;
      callState.pendingParamValues = [value];
      callState.pendingParamIsArray = false;
    };

    const commitAndSealPending = (
      controller: StreamController,
      callState: StreamingCallState
    ) => {
      const prev = callState.pendingParamName;
      if (!prev) {
        return;
      }
      if (!callState.pendingParamIsArray) {
        callState.args[prev] = callState.pendingParamValues[0] ?? "";
        maybeEmitToolInputProgress(controller, callState);
      }
      callState.sealedKeys.add(prev);
    };

    const handleRepeatParamValue = (
      controller: StreamController,
      callState: StreamingCallState,
      key: string,
      value: string
    ) => {
      callState.pendingParamValues.push(value);
      if (callState.pendingParamIsArray) {
        const arr = callState.args[key];
        if (Array.isArray(arr)) {
          arr.push(value);
        }
        maybeEmitToolInputProgress(controller, callState);
        return;
      }

      if (callState.pendingParamValues.length >= 2) {
        callState.pendingParamIsArray = true;
        callState.args[key] = [...callState.pendingParamValues];
        maybeEmitToolInputProgress(controller, callState);
      }
    };

    const handleParamValue = (
      controller: StreamController,
      callState: StreamingCallState,
      name: string,
      value: string
    ) => {
      const key = name.trim();
      if (key.length === 0) {
        return;
      }

      if (callState.sealedKeys.has(key)) {
        options?.onError?.(
          "Ignoring non-contiguous repeated UI-TARS parameter",
          {
            name: key,
          }
        );
        return;
      }

      if (callState.pendingParamName == null) {
        startPendingParam(callState, key, value);
        return;
      }

      if (key === callState.pendingParamName) {
        handleRepeatParamValue(controller, callState, key, value);
        return;
      }

      // Key switch: commit the previous pending key now, then begin the new one.
      commitAndSealPending(controller, callState);
      startPendingParam(callState, key, value);
    };

    const finalizeCall = (
      controller: StreamController,
      callState: StreamingCallState,
      fallbackToolName: string | null
    ): boolean => {
      if (callState.pendingParamName) {
        const pendingName = callState.pendingParamName;
        if (!callState.pendingParamIsArray) {
          callState.args[pendingName] = callState.pendingParamValues[0] ?? "";
          maybeEmitToolInputProgress(controller, callState);
        }
        callState.sealedKeys.add(pendingName);
        callState.pendingParamName = null;
        callState.pendingParamValues = [];
        callState.pendingParamIsArray = false;
      }

      if (!callState.toolName && fallbackToolName) {
        callState.toolName = fallbackToolName;
      }

      if (!callState.toolName || callState.toolName.trim().length === 0) {
        options?.onError?.(
          "Could not resolve UI-TARS tool name for tool call",
          {
            toolCallId: callState.toolCallId,
          }
        );
        if (callState.hasEmittedStart) {
          controller.enqueue({
            type: "tool-input-end",
            id: callState.toolCallId,
          });
        }
        return false;
      }

      maybeEmitToolInputStart(controller, callState);
      maybeEmitToolInputProgress(controller, callState);

      const finalInput = JSON.stringify(callState.args);
      emitFinalRemainder({
        controller,
        id: callState.toolCallId,
        state: callState,
        finalFullJson: finalInput,
        onMismatch: options?.onError,
      });
      controller.enqueue({
        type: "tool-input-end",
        id: callState.toolCallId,
      });
      controller.enqueue({
        type: "tool-call",
        toolCallId: callState.toolCallId,
        toolName: callState.toolName,
        input: finalInput,
      });
      return true;
    };

    const consumeToolNameTag = (
      controller: StreamController,
      callState: StreamingCallState,
      work: string
    ) => {
      if (callState.toolName) {
        return work;
      }
      const match = UI_TARS_STREAM_NAME_TAG_RE.exec(work);
      if (!match) {
        return work;
      }
      const value = normalizeXmlTextValue(match[2] ?? "");
      if (value.trim().length > 0) {
        callState.toolName = value;
      }
      const start = match.index ?? 0;
      const nextWork = removeSlice(
        work,
        start,
        start + (match[0]?.length ?? 0)
      );
      maybeEmitToolInputStart(controller, callState);
      return nextWork;
    };

    const consumeParamTags = (
      controller: StreamController,
      callState: StreamingCallState,
      work: string
    ) => {
      let out = work;
      while (true) {
        const next = findNextParamTag(out);
        if (!next) {
          break;
        }
        const { start, end, name, value } = next;
        handleParamValue(controller, callState, name, value);
        out = removeSlice(out, start, end);
        flushPendingIfPossible(controller, callState, out);
      }
      return out;
    };

    const ensureStreamingUpToDate = (
      controller: StreamController,
      callState: StreamingCallState,
      work: string
    ) => {
      flushPendingIfPossible(controller, callState, work);
      maybeEmitToolInputStart(controller, callState);
      maybeEmitToolInputProgress(controller, callState);
    };

    const parseCallContent = (
      controller: StreamController,
      callState: StreamingCallState,
      content: string
    ): string => {
      let work = content;
      work = consumeToolNameTag(controller, callState, work);
      work = consumeParamTags(controller, callState, work);
      ensureStreamingUpToDate(controller, callState, work);
      return work;
    };

    const consumeCall = (
      controller: StreamController,
      callState: StreamingCallState,
      incoming: string,
      fallbackToolName: string | null
    ): { done: boolean; remainder: string } => {
      callState.buffer += incoming;

      const closeTagRe = new RegExp(
        `<\\s*\\/\\s*${escapeRegExp(callState.endTagName)}\\s*>`,
        "i"
      );
      const closeMatch = closeTagRe.exec(callState.buffer);
      if (!closeMatch) {
        callState.buffer = parseCallContent(
          controller,
          callState,
          callState.buffer
        );
        return { done: false, remainder: "" };
      }

      const closeStart = closeMatch.index ?? 0;
      const closeEnd = closeStart + (closeMatch[0]?.length ?? 0);
      const beforeClose = callState.buffer.slice(0, closeStart);
      const afterClose = callState.buffer.slice(closeEnd);

      parseCallContent(controller, callState, beforeClose);
      callState.buffer = "";
      const ok = finalizeCall(controller, callState, fallbackToolName);
      if (ok && toolCall) {
        toolCall.emittedToolCallCount += 1;
      }

      return { done: true, remainder: afterClose };
    };

    const finalizeCallAtFinish = (
      controller: StreamController,
      callState: StreamingCallState,
      fallbackToolName: string | null
    ): boolean => {
      callState.buffer = parseCallContent(
        controller,
        callState,
        callState.buffer
      );
      callState.buffer = "";
      return finalizeCall(controller, callState, fallbackToolName);
    };

    const flushSafeTextPrefix = (controller: StreamController) => {
      const lower = buffer.toLowerCase();
      const potentialIndex = getPotentialStartIndex(
        lower,
        toolCallStartPrefixLower
      );
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

    const startToolCallIfPresent = (_controller: StreamController) => {
      if (toolCall) {
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

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Stream tool-call parsing is a nested state machine.
    const processToolCall = (controller: StreamController) => {
      while (toolCall) {
        if (toolCall.mode === "unknown") {
          const callMatch = UI_TARS_STREAM_CALL_OPEN_START_RE.exec(
            toolCall.innerBuffer
          );
          const signalMatch = UI_TARS_STREAM_NAME_OR_PARAM_SIGNAL_RE.exec(
            toolCall.innerBuffer
          );
          if (
            callMatch &&
            (!signalMatch || (callMatch.index ?? 0) < (signalMatch.index ?? 0))
          ) {
            toolCall.mode = "multi";
          } else if (signalMatch) {
            toolCall.mode = "single";
            toolCall.activeCall = {
              endTagName: "tool_call",
              toolCallId: generateToolCallId(),
              toolName: toolCall.outerNameAttr,
              hasEmittedStart: false,
              emittedInput: "",
              args: {},
              pendingParamName: null,
              pendingParamValues: [],
              pendingParamIsArray: false,
              buffer: "",
              sealedKeys: new Set<string>(),
            };
            if (toolCall.outerNameAttr) {
              maybeEmitToolInputStart(controller, toolCall.activeCall);
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
          startToolCallIfPresent(controller);
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

          const closeMatch = UI_TARS_STREAM_TOOL_CALL_CLOSE_TAG_RE.exec(
            toolCall.innerBuffer
          );
          const callOpenMatch = UI_TARS_STREAM_CALL_OPEN_TAG_RE.exec(
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
            startToolCallIfPresent(controller);
            continue;
          }

          if (!callOpenMatch) {
            return;
          }

          const openTag = callOpenMatch[0] ?? "";
          const callTagName = (callOpenMatch[1] ?? "").toLowerCase();
          const rest = toolCall.innerBuffer.slice(openTag.length);

          const selfClosing = UI_TARS_STREAM_SELF_CLOSING_TAG_RE.test(openTag);
          if (selfClosing) {
            const toolNameAttr =
              getAttributeValue(openTag, "name") ?? toolCall.outerNameAttr;
            const immediateCall: StreamingCallState = {
              endTagName: callTagName,
              toolCallId: generateToolCallId(),
              toolName: toolNameAttr,
              hasEmittedStart: false,
              emittedInput: "",
              args: {},
              pendingParamName: null,
              pendingParamValues: [],
              pendingParamIsArray: false,
              buffer: "",
              sealedKeys: new Set<string>(),
            };
            const ok = finalizeCall(controller, immediateCall, toolNameAttr);
            if (ok) {
              toolCall.emittedToolCallCount += 1;
            }
            toolCall.innerBuffer = rest;
            continue;
          }

          const toolNameAttr = getAttributeValue(openTag, "name");
          const newCall: StreamingCallState = {
            endTagName: callTagName,
            toolCallId: generateToolCallId(),
            toolName: toolNameAttr,
            hasEmittedStart: false,
            emittedInput: "",
            args: {},
            pendingParamName: null,
            pendingParamValues: [],
            pendingParamIsArray: false,
            buffer: "",
            sealedKeys: new Set<string>(),
          };

          if (toolNameAttr) {
            maybeEmitToolInputStart(controller, newCall);
          }

          toolCall.activeCall = newCall;
          toolCall.innerBuffer = rest;
        }
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
            const callMatch = UI_TARS_STREAM_CALL_OPEN_START_RE.exec(
              toolCall.innerBuffer
            );
            const signalMatch = UI_TARS_STREAM_NAME_OR_PARAM_SIGNAL_RE.exec(
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
                emittedInput: "",
                args: {},
                pendingParamName: null,
                pendingParamValues: [],
                pendingParamIsArray: false,
                buffer: "",
                sealedKeys: new Set<string>(),
              };
            }
          }

          if (toolCall.mode === "single" && toolCall.activeCall) {
            toolCall.activeCall.buffer += toolCall.innerBuffer;
            toolCall.innerBuffer = "";
            const ok = finalizeCallAtFinish(
              controller,
              toolCall.activeCall,
              toolCall.outerNameAttr
            );
            if (ok) {
              toolCall.emittedToolCallCount += 1;
            }
            if (!ok && toolCall.emittedToolCallCount === 0) {
              const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
              options?.onError?.(
                shouldEmitRaw
                  ? "Could not complete streaming UI-TARS XML tool call at finish; emitting original text."
                  : "Could not complete streaming UI-TARS XML tool call at finish.",
                { toolCall: toolCall.raw }
              );
              if (shouldEmitRaw) {
                flushText(controller, toolCall.raw);
              }
            }
          } else if (toolCall.mode === "multi") {
            if (toolCall.activeCall) {
              const ok = finalizeCallAtFinish(
                controller,
                toolCall.activeCall,
                toolCall.outerNameAttr
              );
              if (ok) {
                toolCall.emittedToolCallCount += 1;
              } else if (toolCall.emittedToolCallCount === 0) {
                const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
                options?.onError?.(
                  shouldEmitRaw
                    ? "Could not complete streaming UI-TARS XML tool call at finish; emitting original text."
                    : "Could not complete streaming UI-TARS XML tool call at finish.",
                  { toolCall: toolCall.raw }
                );
                if (shouldEmitRaw) {
                  flushText(controller, toolCall.raw);
                }
              }
              toolCall.activeCall = null;
            } else if (toolCall.emittedToolCallCount === 0) {
              const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
              options?.onError?.(
                shouldEmitRaw
                  ? "Could not complete streaming UI-TARS XML tool call at finish; emitting original text."
                  : "Could not complete streaming UI-TARS XML tool call at finish.",
                { toolCall: toolCall.raw }
              );
              if (shouldEmitRaw) {
                flushText(controller, toolCall.raw);
              }
            }
          } else {
            const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
            options?.onError?.(
              shouldEmitRaw
                ? "Could not complete streaming UI-TARS XML tool call at finish; emitting original text."
                : "Could not complete streaming UI-TARS XML tool call at finish.",
              { toolCall: toolCall.raw }
            );
            if (shouldEmitRaw) {
              flushText(controller, toolCall.raw);
            }
          }

          toolCall = null;
        }
      }

      if (buffer.length > 0) {
        flushText(controller, buffer);
        buffer = "";
      }

      flushText(controller);
    };

    return new TransformStream({
      transform(chunk, controller) {
        if (chunk.type === "finish") {
          handleFinish(controller);
          controller.enqueue(chunk);
          return;
        }

        if (chunk.type !== "text-delta") {
          if (!toolCall && buffer) {
            flushText(controller, buffer);
            buffer = "";
          }
          controller.enqueue(chunk);
          return;
        }

        const delta = chunk.delta;
        if (!delta) {
          return;
        }

        if (toolCall) {
          toolCall.raw += delta;
          toolCall.innerBuffer += delta;
          processToolCall(controller);
          return;
        }

        buffer += delta;
        flushSafeTextPrefix(controller);
        startToolCallIfPresent(controller);
        processToolCall(controller);
      },
      flush(controller) {
        handleFinish(controller);
      },
    });
  },
});
