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
import { generateId, generateToolCallId } from "../utils/id";
import { createFlushTextHandler } from "../utils/protocol-utils";
import { escapeRegExp } from "../utils/regex";
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
    const toolCallStartPrefix = "<tool_call";
    const toolCallEndPrefix = "</tool_call";

    let buffer = "";
    let toolCallBuffer = "";
    let isInsideToolCall = false;
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

    const emitToolCalls = (
      controller: StreamController,
      segment: string
    ): boolean => {
      const parsedCalls = parseUiTarsToolCallSegment(segment);
      if (!parsedCalls) {
        const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
        options?.onError?.(
          shouldEmitRaw
            ? "Could not process streaming UI-TARS XML tool call; emitting original text."
            : "Could not process streaming UI-TARS XML tool call.",
          { toolCall: segment }
        );
        if (shouldEmitRaw) {
          flushText(controller, segment);
        }
        return false;
      }

      flushText(controller);
      for (const call of parsedCalls) {
        const toolCallId = generateToolCallId();
        const input = JSON.stringify(call.args);
        controller.enqueue({
          type: "tool-input-start",
          id: toolCallId,
          toolName: call.toolName,
        } as LanguageModelV3StreamPart);
        controller.enqueue({
          type: "tool-input-delta",
          id: toolCallId,
          delta: input,
        } as LanguageModelV3StreamPart);
        controller.enqueue({
          type: "tool-input-end",
          id: toolCallId,
        } as LanguageModelV3StreamPart);
        controller.enqueue({
          type: "tool-call",
          toolCallId,
          toolName: call.toolName,
          input,
        } as LanguageModelV3StreamPart);
      }
      return true;
    };

    const flushSafeTextPrefix = (controller: StreamController) => {
      const potentialIndex = getPotentialStartIndex(
        buffer,
        toolCallStartPrefix
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

    const processToolCallBuffer = (controller: StreamController) => {
      while (true) {
        const endStartIndex = getPotentialStartIndex(
          toolCallBuffer,
          toolCallEndPrefix
        );
        if (endStartIndex == null) {
          return;
        }
        const gtIndex = toolCallBuffer.indexOf(">", endStartIndex);
        if (gtIndex === -1) {
          return;
        }
        const segment = toolCallBuffer.slice(0, gtIndex + 1);
        const remainder = toolCallBuffer.slice(gtIndex + 1);

        emitToolCalls(controller, segment);
        toolCallBuffer = "";
        isInsideToolCall = false;

        buffer = remainder + buffer;
        flushSafeTextPrefix(controller);

        const nextStartIndex = getPotentialStartIndex(
          buffer,
          toolCallStartPrefix
        );
        if (nextStartIndex !== 0) {
          return;
        }

        toolCallBuffer += buffer;
        buffer = "";
        isInsideToolCall = true;
      }
    };

    const startToolCallIfPresent = (controller: StreamController) => {
      const startIndex = getPotentialStartIndex(buffer, toolCallStartPrefix);
      if (startIndex == null || startIndex !== 0) {
        return;
      }

      // Ensure we have a full opening tag before switching into tool-call mode.
      const gtIndex = buffer.indexOf(">");
      if (gtIndex === -1) {
        return;
      }

      const prefix = buffer.slice(0, gtIndex + 1);
      if (!TOOL_CALL_OPEN_RE.test(prefix)) {
        return;
      }

      toolCallBuffer = prefix;
      buffer = buffer.slice(gtIndex + 1);
      isInsideToolCall = true;

      if (buffer.length > 0) {
        toolCallBuffer += buffer;
        buffer = "";
      }

      processToolCallBuffer(controller);
    };

    const handleFinish = (controller: StreamController) => {
      if (isInsideToolCall) {
        const shouldEmitRaw = shouldEmitRawToolCallTextOnError(options);
        const errorContent = toolCallBuffer;
        options?.onError?.(
          shouldEmitRaw
            ? "Could not complete streaming UI-TARS XML tool call at finish; emitting original text."
            : "Could not complete streaming UI-TARS XML tool call at finish.",
          { toolCall: errorContent }
        );
        if (shouldEmitRaw) {
          const errorId = generateId();
          controller.enqueue({
            type: "text-start",
            id: errorId,
          } as LanguageModelV3StreamPart);
          controller.enqueue({
            type: "text-delta",
            id: errorId,
            delta: errorContent,
          } as LanguageModelV3StreamPart);
          controller.enqueue({
            type: "text-end",
            id: errorId,
          } as LanguageModelV3StreamPart);
        }
        toolCallBuffer = "";
        isInsideToolCall = false;
      }

      if (buffer.length > 0) {
        flushText(controller, buffer);
        buffer = "";
      }

      flushText(controller);
    };

    return new TransformStream({
      transform(chunk, controller) {
        if (chunk.type === "text-delta") {
          const delta = chunk.delta;
          if (!delta) {
            return;
          }

          if (isInsideToolCall) {
            toolCallBuffer += delta;
            processToolCallBuffer(controller);
            return;
          }

          buffer += delta;
          flushSafeTextPrefix(controller);
          startToolCallIfPresent(controller);
          return;
        }

        if (chunk.type === "finish") {
          handleFinish(controller);
          controller.enqueue(chunk);
          return;
        }

        handleFinish(controller);
        controller.enqueue(chunk);
      },
    });
  },
});
