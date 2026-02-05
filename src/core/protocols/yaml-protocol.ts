import type {
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider";
import YAML from "yaml";
import { generateId } from "../utils/id";
import { NAME_CHAR_RE, WHITESPACE_REGEX } from "../utils/regex-constants";
import type { TCMCoreProtocol } from "./protocol-interface";

export interface YamlProtocolOptions {
  /**
   * Whether to include a system prompt example showing YAML multiline syntax.
   * @default true
   */
  includeMultilineExample?: boolean;
}

interface ParserOptions {
  onError?: (message: string, metadata?: Record<string, unknown>) => void;
}

const LEADING_WHITESPACE_RE = /^(\s*)/;

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
  toolName: string;
  startIndex: number;
  endIndex: number;
  content: string;
}

function collectToolCallsForName(
  text: string,
  toolName: string
): ToolCallMatch[] {
  const toolCalls: ToolCallMatch[] = [];
  let searchIndex = 0;
  const selfTagRegex = new RegExp(`<${toolName}\\s*/>`, "g");

  while (searchIndex < text.length) {
    const startTag = `<${toolName}>`;
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
  let normalized = yamlContent;
  if (normalized.startsWith("\n")) {
    normalized = normalized.slice(1);
  }

  const lines = normalized.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);

  if (nonEmptyLines.length === 0) {
    return {};
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

  try {
    const doc = YAML.parseDocument(normalized);

    if (doc.errors && doc.errors.length > 0) {
      options?.onError?.("YAML parse error", {
        errors: doc.errors.map((e: { message: string }) => e.message),
      });
      return null;
    }

    const result = doc.toJSON();

    if (result === null) {
      return {};
    }

    if (typeof result !== "object" || Array.isArray(result)) {
      options?.onError?.("YAML content must be a key-value mapping", {
        got: typeof result,
      });
      return null;
    }

    return result as Record<string, unknown>;
  } catch (error) {
    options?.onError?.("Failed to parse YAML content", { error });
    return null;
  }
}

function appendTextPart(
  processedElements: LanguageModelV3Content[],
  textPart: string
) {
  if (textPart.trim()) {
    processedElements.push({
      type: "text",
      text: textPart,
    });
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

  appendTextPart(
    processedElements,
    text.substring(currentIndex, tc.startIndex)
  );

  const parsedArgs = parseYamlContent(tc.content, options);
  if (parsedArgs !== null) {
    processedElements.push({
      type: "tool-call",
      toolCallId: generateId(),
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
    const selfTagRegex = new RegExp(`<${name}\\s*/>`);
    const idxOpen = buffer.indexOf(openTag);
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

      const toolCalls = findToolCalls(text, toolNames);

      for (const tc of toolCalls) {
        currentIndex = processToolCallMatch(
          text,
          tc,
          currentIndex,
          processedElements,
          options
        );
      }

      if (currentIndex < text.length) {
        appendTextPart(processedElements, text.substring(currentIndex));
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

      const processToolCallEnd = (
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
        toolContent: string,
        toolName: string
      ) => {
        const parsedArgs = parseYamlContent(toolContent, options);
        flushText(controller);

        if (parsedArgs !== null) {
          controller.enqueue({
            type: "tool-call",
            toolCallId: generateId(),
            toolName,
            input: JSON.stringify(parsedArgs),
          });
        } else {
          const original = `<${toolName}>${toolContent}</${toolName}>`;
          options?.onError?.("Could not parse streaming YAML tool call", {
            toolCall: original,
          });
          flushText(controller, original);
        }
      };

      const handlePendingToolCall = (
        controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
        endTag: string,
        toolName: string
      ): boolean => {
        const endIdx = buffer.indexOf(endTag);
        if (endIdx === -1) {
          return false;
        }

        const content = buffer.substring(0, endIdx);
        buffer = buffer.substring(endIdx + endTag.length);
        processToolCallEnd(controller, content, toolName);
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

        if (selfClosing) {
          buffer = buffer.substring(tagIndex + tagLength);
          processToolCallEnd(controller, "", tagName);
        } else {
          const startTag = `<${tagName}>`;
          buffer = buffer.substring(tagIndex + startTag.length);
          currentToolCall = { name: tagName, content: "" };
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
            const unfinishedContent = `<${currentToolCall.name}>${buffer}`;
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

      return findToolCalls(text, toolNames).map(
        (tc) => `<${tc.toolName}>${tc.content}</${tc.toolName}>`
      );
    },
  };
};
