import type {
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider";
import YAML from "yaml";
import { generateToolCallId } from "../utils/id";
import {
  addTextSegment,
  createFlushTextHandler,
} from "../utils/protocol-utils";
import { escapeRegExp } from "../utils/regex";
import { NAME_CHAR_RE, WHITESPACE_REGEX } from "../utils/regex-constants";
import {
  emitFinalRemainder,
  emitPrefixDelta,
  toIncompleteJsonPrefix,
} from "../utils/streamed-tool-input-delta";
import { tryRepairXmlSelfClosingRootWithBody } from "../utils/xml-root-repair";
import type { ParserOptions, TCMCoreProtocol } from "./protocol-interface";

export interface YamlProtocolOptions {
  /**
   * Whether to include a system prompt example showing YAML multiline syntax.
   * @default true
   */
  includeMultilineExample?: boolean;
}

function shouldEmitRawToolCallTextOnError(options?: ParserOptions): boolean {
  return options?.emitRawToolCallTextOnError === true;
}

const selfClosingTagCache = new Map<string, RegExp>();

function getSelfClosingTagPattern(toolName: string): RegExp {
  let pattern = selfClosingTagCache.get(toolName);
  if (!pattern) {
    pattern = new RegExp(`<\\s*${escapeRegExp(toolName)}\\s*/>`, "g");
    selfClosingTagCache.set(toolName, pattern);
  }
  return pattern;
}

const LEADING_WHITESPACE_RE = /^(\s*)/;
const INCOMPLETE_MAPPING_TAIL_RE = /^[^:[\]{}-][^:]*:\s*$/;
const INCOMPLETE_SEQUENCE_TAIL_RE = /^-\s*$/;
const BLOCK_SCALAR_KEY_RE = /:\s*[|>][-+0-9]*\s*$/;
const PLAIN_MAPPING_VALUE_RE = /^[^:[\]{}-][^:]*:\s*(.+)$/;
const PLAIN_SEQUENCE_VALUE_RE = /^-\s+(.+)$/;

interface LastMeaningfulLineInfo {
  indent: number;
  index: number;
  raw: string;
  trimmed: string;
}

function normalizeYamlContent(yamlContent: string): {
  normalized: string;
  nonEmptyLines: string[];
} {
  let normalized = yamlContent;
  if (normalized.startsWith("\n")) {
    normalized = normalized.slice(1);
  }

  const lines = normalized.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  if (nonEmptyLines.length === 0) {
    return { normalized: "", nonEmptyLines };
  }

  const minIndent = Math.min(
    ...nonEmptyLines.map((line) => {
      const match = line.match(LEADING_WHITESPACE_RE);
      return match ? match[1].length : 0;
    })
  );
  if (minIndent > 0) {
    normalized = lines.map((line) => line.slice(minIndent)).join("\n");
  }

  return { normalized, nonEmptyLines };
}

function parseYamlDocumentAsMapping(normalized: string): {
  value: Record<string, unknown> | null;
  errors: string[];
} {
  try {
    const doc = YAML.parseDocument(normalized);
    const errors = doc.errors.map((e: { message: string }) => e.message);
    const result = doc.toJSON();

    if (result === null) {
      return { value: {}, errors };
    }
    if (typeof result !== "object" || Array.isArray(result)) {
      return { value: null, errors };
    }
    return { value: result as Record<string, unknown>, errors };
  } catch (error) {
    return {
      value: null,
      errors: [
        error instanceof Error ? error.message : "Unknown YAML parsing error",
      ],
    };
  }
}

function getLastMeaningfulLineInfo(
  input: string
): LastMeaningfulLineInfo | null {
  const lines = input.split("\n");
  let index = lines.length - 1;
  while (index >= 0) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("#")) {
      return {
        index,
        raw,
        trimmed,
        indent: raw.length - raw.trimStart().length,
      };
    }
    index -= 1;
  }
  return null;
}

function dropLastMeaningfulLine(input: string): string | null {
  const lineInfo = getLastMeaningfulLineInfo(input);
  if (!lineInfo) {
    return null;
  }

  return input.split("\n").slice(0, lineInfo.index).join("\n").trimEnd();
}

function hasIncompleteMappingTail(normalized: string): boolean {
  const lineInfo = getLastMeaningfulLineInfo(normalized);
  if (!lineInfo) {
    return false;
  }
  return INCOMPLETE_MAPPING_TAIL_RE.test(lineInfo.trimmed);
}

function hasIncompleteSequenceTail(normalized: string): boolean {
  const lineInfo = getLastMeaningfulLineInfo(normalized);
  if (!lineInfo) {
    return false;
  }
  return INCOMPLETE_SEQUENCE_TAIL_RE.test(lineInfo.trimmed);
}

function hasSplitNestedKeyTail(normalized: string): boolean {
  const lineInfo = getLastMeaningfulLineInfo(normalized);
  if (!lineInfo) {
    return false;
  }

  const { trimmed, indent, index } = lineInfo;
  if (indent === 0) {
    return false;
  }
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("-") ||
    trimmed.includes(":")
  ) {
    return false;
  }

  const lines = normalized.split("\n");
  let parentIndex = index - 1;
  while (parentIndex >= 0) {
    const parentRaw = lines[parentIndex] ?? "";
    const parentTrimmed = parentRaw.trim();
    if (parentTrimmed.length === 0 || parentTrimmed.startsWith("#")) {
      parentIndex -= 1;
      continue;
    }

    const parentIndent = parentRaw.length - parentRaw.trimStart().length;
    if (parentIndent >= indent) {
      parentIndex -= 1;
      continue;
    }

    if (!parentTrimmed.endsWith(":")) {
      return false;
    }
    if (BLOCK_SCALAR_KEY_RE.test(parentTrimmed)) {
      return false;
    }
    return true;
  }

  return false;
}

function extractTrailingPlainScalarValue(line: string): string | null {
  if (BLOCK_SCALAR_KEY_RE.test(line)) {
    return null;
  }

  const mappingMatch = line.match(PLAIN_MAPPING_VALUE_RE);
  const sequenceMatch = line.match(PLAIN_SEQUENCE_VALUE_RE);
  const value = mappingMatch?.[1] ?? sequenceMatch?.[1];
  if (!value) {
    return null;
  }

  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return null;
  }
  if (trimmedValue.startsWith('"') || trimmedValue.startsWith("'")) {
    return null;
  }
  if (
    trimmedValue.startsWith("{") ||
    trimmedValue.startsWith("[") ||
    trimmedValue.startsWith("|") ||
    trimmedValue.startsWith(">")
  ) {
    return null;
  }

  return trimmedValue;
}

function hasUnterminatedPlainScalarTail(normalized: string): boolean {
  if (normalized.endsWith("\n")) {
    return false;
  }

  const lineInfo = getLastMeaningfulLineInfo(normalized);
  if (!lineInfo) {
    return false;
  }

  return extractTrailingPlainScalarValue(lineInfo.trimmed) != null;
}

function hasUnstableProgressTail(normalized: string): boolean {
  return (
    hasIncompleteMappingTail(normalized) ||
    hasIncompleteSequenceTail(normalized) ||
    hasSplitNestedKeyTail(normalized) ||
    hasUnterminatedPlainScalarTail(normalized)
  );
}

function trimTrailingNewlineInUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.endsWith("\n")) {
      return value.slice(0, -1);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => trimTrailingNewlineInUnknown(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        trimTrailingNewlineInUnknown(item),
      ])
    );
  }

  return value;
}

function stabilizeParsedValueForStreamProgress<T>(value: T, source: string): T {
  if (source.endsWith("\n")) {
    return value;
  }

  return trimTrailingNewlineInUnknown(value) as T;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: XML tag parsing with nested tag tracking inherently requires complex state management
function findClosingTagEnd(
  text: string,
  contentStart: number,
  toolName: string
): number {
  let pos = contentStart;
  let depth = 1;

  while (pos < text.length) {
    const ltIdx = text.indexOf("<", pos);
    if (ltIdx === -1) {
      break;
    }

    const next = text[ltIdx + 1];
    if (next === "/") {
      const gtIdx = text.indexOf(">", ltIdx);
      if (gtIdx === -1) {
        break;
      }

      let p = ltIdx + 2;
      while (p < gtIdx && WHITESPACE_REGEX.test(text[p])) {
        p++;
      }
      const nameStart = p;
      while (p < gtIdx && NAME_CHAR_RE.test(text.charAt(p))) {
        p++;
      }
      const name = text.slice(nameStart, p);

      if (name === toolName) {
        depth--;
        if (depth === 0) {
          return gtIdx + 1;
        }
      }
      pos = gtIdx + 1;
    } else if (next === "!" || next === "?") {
      const gtIdx = text.indexOf(">", ltIdx);
      pos = gtIdx === -1 ? text.length : gtIdx + 1;
    } else {
      let p = ltIdx + 1;
      while (p < text.length && WHITESPACE_REGEX.test(text[p])) {
        p++;
      }
      const nameStart = p;
      while (p < text.length && NAME_CHAR_RE.test(text.charAt(p))) {
        p++;
      }
      const name = text.slice(nameStart, p);

      const gtIdx = text.indexOf(">", p);
      if (gtIdx === -1) {
        break;
      }

      let r = gtIdx - 1;
      while (r >= nameStart && WHITESPACE_REGEX.test(text[r])) {
        r--;
      }
      const selfClosing = text[r] === "/";

      if (name === toolName && !selfClosing) {
        depth++;
      }
      pos = gtIdx + 1;
    }
  }

  return -1;
}

function findEarliestTagPosition(
  openIdx: number,
  selfIdx: number
): { tagStart: number; isSelfClosing: boolean } {
  const hasSelf = selfIdx !== -1;
  const hasOpen = openIdx !== -1;

  if (hasSelf && (!hasOpen || selfIdx < openIdx)) {
    return { tagStart: selfIdx, isSelfClosing: true };
  }
  return { tagStart: openIdx, isSelfClosing: false };
}

/**
 * Find all tool calls in the text for the given tool names.
 */
interface ToolCallMatch {
  content: string;
  endIndex: number;
  startIndex: number;
  toolName: string;
}

function collectToolCallsForName(
  text: string,
  toolName: string
): ToolCallMatch[] {
  const toolCalls: ToolCallMatch[] = [];
  let searchIndex = 0;
  const startTag = `<${toolName}>`;
  const selfTagRegex = getSelfClosingTagPattern(toolName);

  while (searchIndex < text.length) {
    const openIdx = text.indexOf(startTag, searchIndex);

    selfTagRegex.lastIndex = searchIndex;
    const selfMatch = selfTagRegex.exec(text);
    const selfIdx = selfMatch ? selfMatch.index : -1;
    const selfTagLength = selfMatch ? selfMatch[0].length : 0;

    if (openIdx === -1 && selfIdx === -1) {
      break;
    }

    const { tagStart, isSelfClosing } = findEarliestTagPosition(
      openIdx,
      selfIdx
    );

    if (isSelfClosing) {
      const endIndex = tagStart + selfTagLength;
      toolCalls.push({
        toolName,
        startIndex: tagStart,
        endIndex,
        content: "",
      });
      searchIndex = endIndex;
      continue;
    }

    const contentStart = tagStart + startTag.length;
    const fullTagEnd = findClosingTagEnd(text, contentStart, toolName);
    if (fullTagEnd !== -1 && fullTagEnd > contentStart) {
      const endTag = `</${toolName}>`;
      const endTagStart = fullTagEnd - endTag.length;
      const content = text.substring(contentStart, endTagStart);
      toolCalls.push({
        toolName,
        startIndex: tagStart,
        endIndex: fullTagEnd,
        content,
      });
      searchIndex = fullTagEnd;
    } else {
      searchIndex = contentStart;
    }
  }

  return toolCalls;
}

function findToolCalls(text: string, toolNames: string[]): ToolCallMatch[] {
  const toolCalls = toolNames.flatMap((toolName) =>
    collectToolCallsForName(text, toolName)
  );
  return toolCalls.sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * Parse YAML content from inside an XML tag.
 * Handles common LLM output issues like inconsistent indentation.
 */
function parseYamlContent(
  yamlContent: string,
  options?: ParserOptions
): Record<string, unknown> | null {
  const { normalized, nonEmptyLines } = normalizeYamlContent(yamlContent);
  if (nonEmptyLines.length === 0) {
    return {};
  }

  const parsed = parseYamlDocumentAsMapping(normalized);
  if (parsed.errors.length > 0) {
    options?.onError?.("YAML parse error", {
      errors: parsed.errors,
    });
    return null;
  }

  if (parsed.value === null) {
    options?.onError?.("YAML content must be a key-value mapping", {
      got: "non-mapping",
    });
    return null;
  }

  return parsed.value;
}

function parseYamlContentForStreamProgress(
  yamlContent: string
): Record<string, unknown> | null {
  const { normalized, nonEmptyLines } = normalizeYamlContent(yamlContent);
  if (nonEmptyLines.length === 0) {
    return {};
  }

  let candidate = normalized;
  while (true) {
    const parsed = parseYamlDocumentAsMapping(candidate);
    if (parsed.errors.length === 0 && !hasUnstableProgressTail(candidate)) {
      if (candidate.trim().length === 0 && normalized.trim().length > 0) {
        return null;
      }
      return stabilizeParsedValueForStreamProgress(parsed.value, candidate);
    }

    const truncated = dropLastMeaningfulLine(candidate);
    if (truncated == null) {
      return null;
    }
    if (truncated === candidate) {
      return null;
    }
    candidate = truncated;
  }
}

function processToolCallMatch(
  text: string,
  tc: ToolCallMatch,
  currentIndex: number,
  processedElements: LanguageModelV3Content[],
  options?: ParserOptions
): number {
  if (tc.startIndex < currentIndex) {
    return currentIndex;
  }

  addTextSegment(
    text.substring(currentIndex, tc.startIndex),
    processedElements
  );

  const parsedArgs = parseYamlContent(tc.content, options);
  if (parsedArgs !== null) {
    processedElements.push({
      type: "tool-call",
      toolCallId: generateToolCallId(),
      toolName: tc.toolName,
      input: JSON.stringify(parsedArgs),
    });
  } else {
    const originalText = text.substring(tc.startIndex, tc.endIndex);
    options?.onError?.("Could not parse YAML tool call", {
      toolCall: originalText,
    });
    processedElements.push({ type: "text", text: originalText });
  }

  return tc.endIndex;
}

function findEarliestToolTag(
  buffer: string,
  toolNames: string[]
): { index: number; name: string; selfClosing: boolean; tagLength: number } {
  let bestIndex = -1;
  let bestName = "";
  let bestSelfClosing = false;
  let bestTagLength = 0;

  for (const name of toolNames) {
    const openTag = `<${name}>`;
    const selfTagRegex = getSelfClosingTagPattern(name);
    const idxOpen = buffer.indexOf(openTag);
    selfTagRegex.lastIndex = 0;
    const selfMatch = selfTagRegex.exec(buffer);
    const idxSelf = selfMatch ? selfMatch.index : -1;

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
      bestTagLength = selfMatch ? selfMatch[0].length : 0;
    }
  }

  return {
    index: bestIndex,
    name: bestName,
    selfClosing: bestSelfClosing,
    tagLength: bestTagLength,
  };
}

function stripTrailingPartialCloseTag(
  content: string,
  toolName: string
): string {
  const closeTag = `</${toolName}>`;
  const lastLineBreakIndex = Math.max(
    content.lastIndexOf("\n"),
    content.lastIndexOf("\r")
  );
  const lineStartIndex = lastLineBreakIndex === -1 ? 0 : lastLineBreakIndex + 1;
  const trailingLine = content.slice(lineStartIndex);
  const trimmedTrailingLine = trailingLine.trim();

  if (
    trimmedTrailingLine.length === 0 ||
    !trimmedTrailingLine.startsWith("</") ||
    trimmedTrailingLine === closeTag ||
    !closeTag.startsWith(trimmedTrailingLine)
  ) {
    return content;
  }

  const leadingWhitespaceLength =
    trailingLine.length - trailingLine.trimStart().length;
  const preservedLeadingWhitespace = trailingLine.slice(
    0,
    leadingWhitespaceLength
  );
  const contentWithoutPartial = `${content.slice(
    0,
    lineStartIndex
  )}${preservedLeadingWhitespace}`;

  return contentWithoutPartial.trimEnd();
}

export const yamlProtocol = (
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for future extensibility
  _protocolOptions?: YamlProtocolOptions
): TCMCoreProtocol => {
  return {
    formatTools({ tools, toolSystemPromptTemplate }) {
      return toolSystemPromptTemplate(tools || []);
    },

    formatToolCall(toolCall: LanguageModelV3ToolCall): string {
      let args: Record<string, unknown> = {};
      if (toolCall.input != null) {
        try {
          args = JSON.parse(toolCall.input) as Record<string, unknown>;
        } catch {
          args = { value: toolCall.input };
        }
      }
      const yamlContent = YAML.stringify(args);
      return `<${toolCall.toolName}>\n${yamlContent}</${toolCall.toolName}>`;
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
        currentIndex = processToolCallMatch(
          parseText,
          tc,
          currentIndex,
          processedElements,
          options
        );
      }

      if (currentIndex < parseText.length) {
        addTextSegment(parseText.substring(currentIndex), processedElements);
      }

      return processedElements;
    },

    createStreamParser({ tools, options }) {
      const toolNames = tools.map((t) => t.name).filter(Boolean) as string[];

      let buffer = "";
      let currentToolCall: {
        name: string;
        toolCallId: string;
        emittedInput: string;
      } | null = null;
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

      const emitToolInputProgress = (
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
        toolContent: string
      ) => {
        if (!currentToolCall) {
          return;
        }
        const parsedArgs = parseYamlContentForStreamProgress(toolContent);
        if (parsedArgs === null) {
          return;
        }
        const fullInput = JSON.stringify(parsedArgs);
        if (fullInput === "{}" && toolContent.trim().length === 0) {
          return;
        }
        const prefixCandidate = toIncompleteJsonPrefix(fullInput);
        emitPrefixDelta({
          controller,
          id: currentToolCall.toolCallId,
          state: currentToolCall,
          candidate: prefixCandidate,
        });
      };

      const processToolCallEnd = (
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
        toolContent: string,
        toolName: string,
        toolCallId: string
      ) => {
        const parsedArgs = parseYamlContent(toolContent, options);
        flushText(controller);
        if (parsedArgs !== null) {
          const finalInput = JSON.stringify(parsedArgs);
          if (currentToolCall && currentToolCall.toolCallId === toolCallId) {
            emitFinalRemainder({
              controller,
              id: toolCallId,
              state: currentToolCall,
              finalFullJson: finalInput,
              onMismatch: options?.onError,
            });
          }
          controller.enqueue({
            type: "tool-input-end",
            id: toolCallId,
          });
          controller.enqueue({
            type: "tool-call",
            toolCallId,
            toolName,
            input: finalInput,
          });
        } else {
          controller.enqueue({
            type: "tool-input-end",
            id: toolCallId,
          });
          const original = `<${toolName}>${toolContent}</${toolName}>`;
          options?.onError?.("Could not parse streaming YAML tool call", {
            toolCall: original,
          });
          if (shouldEmitRawToolCallTextOnError(options)) {
            flushText(controller, original);
          }
        }
      };

      const finalizeUnclosedToolCall = (
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
      ) => {
        if (!currentToolCall) {
          return;
        }

        emitToolInputProgress(controller, buffer);
        const { name: toolName, toolCallId } = currentToolCall;
        const reconciledBuffer = stripTrailingPartialCloseTag(buffer, toolName);
        const parsedArgs = parseYamlContent(reconciledBuffer, options);
        flushText(controller);
        if (parsedArgs !== null) {
          const finalInput = JSON.stringify(parsedArgs);
          emitFinalRemainder({
            controller,
            id: toolCallId,
            state: currentToolCall,
            finalFullJson: finalInput,
            onMismatch: options?.onError,
          });
          controller.enqueue({
            type: "tool-input-end",
            id: toolCallId,
          });
          controller.enqueue({
            type: "tool-call",
            toolCallId,
            toolName,
            input: finalInput,
          });
        } else {
          controller.enqueue({
            type: "tool-input-end",
            id: toolCallId,
          });
          const unfinishedContent = `<${toolName}>${buffer}`;
          options?.onError?.(
            "Could not complete streaming YAML tool call at finish.",
            { toolCall: unfinishedContent }
          );
          if (shouldEmitRawToolCallTextOnError(options)) {
            flushText(controller, unfinishedContent);
          }
        }

        buffer = "";
        currentToolCall = null;
      };

      const handlePendingToolCall = (
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
        endTag: string,
        toolName: string
      ): boolean => {
        const endIdx = buffer.indexOf(endTag);
        if (endIdx === -1) {
          emitToolInputProgress(controller, buffer);
          return false;
        }

        const content = buffer.substring(0, endIdx);
        emitToolInputProgress(controller, content);
        buffer = buffer.substring(endIdx + endTag.length);
        processToolCallEnd(
          controller,
          content,
          toolName,
          currentToolCall?.toolCallId ?? generateToolCallId()
        );
        currentToolCall = null;
        return true;
      };

      const flushSafeText = (
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
      ): void => {
        const maxTagLen = toolNames.length
          ? Math.max(...toolNames.map((n) => `<${n} />`.length))
          : 0;
        const tail = Math.max(0, maxTagLen - 1);
        const safeLen = Math.max(0, buffer.length - tail);
        if (safeLen > 0) {
          flushText(controller, buffer.slice(0, safeLen));
          buffer = buffer.slice(safeLen);
        }
      };

      const handleNewToolTag = (
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
        tagIndex: number,
        tagName: string,
        selfClosing: boolean,
        tagLength: number
      ): void => {
        if (tagIndex > 0) {
          flushText(controller, buffer.substring(0, tagIndex));
        }

        flushText(controller);

        if (selfClosing) {
          buffer = buffer.substring(tagIndex + tagLength);
          const toolCallId = generateToolCallId();
          currentToolCall = {
            name: tagName,
            toolCallId,
            emittedInput: "",
          };
          controller.enqueue({
            type: "tool-input-start",
            id: toolCallId,
            toolName: tagName,
          });
          processToolCallEnd(controller, "", tagName, toolCallId);
          currentToolCall = null;
        } else {
          const startTag = `<${tagName}>`;
          buffer = buffer.substring(tagIndex + startTag.length);
          currentToolCall = {
            name: tagName,
            toolCallId: generateToolCallId(),
            emittedInput: "",
          };
          controller.enqueue({
            type: "tool-input-start",
            id: currentToolCall.toolCallId,
            toolName: tagName,
          });
        }
      };

      const processBuffer = (
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>
      ) => {
        while (true) {
          if (currentToolCall) {
            const toolName = currentToolCall.name;
            const endTag = `</${toolName}>`;
            if (!handlePendingToolCall(controller, endTag, toolName)) {
              break;
            }
          } else {
            const { index, name, selfClosing, tagLength } = findEarliestToolTag(
              buffer,
              toolNames
            );

            if (index === -1) {
              flushSafeText(controller);
              break;
            }

            handleNewToolTag(controller, index, name, selfClosing, tagLength);
          }
        }
      };

      return new TransformStream({
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
            if (!currentToolCall && buffer) {
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

      return findToolCalls(text, toolNames).map(
        (tc) => `<${tc.toolName}>${tc.content}</${tc.toolName}>`
      );
    },
  };
};
