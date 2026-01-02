import { unwrapJsonSchema, stringify as xmlStringify } from "@ai-sdk-tool/rxml";
import YAML from "yaml";
import type {
  TCMCoreContentPart,
  TCMCoreStreamPart,
  TCMCoreToolCall,
  TCMCoreToolResult,
} from "../types";
import { generateId } from "../utils/id";
import type { ToolCallProtocol } from "./tool-call-protocol";

export interface YamlXmlProtocolOptions {
  /**
   * Whether to include a system prompt example showing YAML multiline syntax.
   * @default true
   */
  includeMultilineExample?: boolean;
}

interface ParserOptions {
  onError?: (message: string, metadata?: Record<string, unknown>) => void;
}

const NAME_CHAR_RE = /[A-Za-z0-9_:-]/;
const WHITESPACE_REGEX = /\s/;
const LEADING_WHITESPACE_RE = /^(\s*)/;
const NUMERIC_STRING_RE = /^\d+$/;

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

/**
 * Find all tool calls in the text for the given tool names.
 */
function findToolCalls(
  text: string,
  toolNames: string[]
): Array<{
  toolName: string;
  startIndex: number;
  endIndex: number;
  content: string;
}> {
  const toolCalls: Array<{
    toolName: string;
    startIndex: number;
    endIndex: number;
    content: string;
  }> = [];

  for (const toolName of toolNames) {
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
  }

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

/**
 * Convert a JavaScript value to YAML string for tool call formatting.
 */
function toYamlValue(value: unknown, indent = 0): string {
  const indentStr = "  ".repeat(indent);

  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "string") {
    if (value.includes("\n")) {
      const lines = value.split("\n");
      return `|\n${lines.map((line) => `${indentStr}  ${line}`).join("\n")}`;
    }
    if (
      value === "" ||
      value === "true" ||
      value === "false" ||
      value === "null" ||
      NUMERIC_STRING_RE.test(value) ||
      value.includes(":") ||
      value.includes("#")
    ) {
      return `'${value.replace(/'/g, "''")}'`;
    }
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return value
      .map((item) => `\n${indentStr}- ${toYamlValue(item, indent + 1)}`)
      .join("");
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return "{}";
    }
    return entries
      .map(([k, v]) => {
        const valStr = toYamlValue(v, indent + 1);
        if (valStr.startsWith("\n") || valStr.startsWith("|")) {
          return `\n${indentStr}${k}: ${valStr}`;
        }
        return `\n${indentStr}${k}: ${valStr}`;
      })
      .join("");
  }

  return String(value);
}

/**
 * Format tool call arguments as YAML.
 */
function formatArgsAsYaml(args: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const valStr = toYamlValue(value, 0);
    if (valStr.startsWith("|") || valStr.startsWith("\n")) {
      lines.push(`${key}: ${valStr}`);
    } else {
      lines.push(`${key}: ${valStr}`);
    }
  }
  return lines.join("\n");
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

function findEarliestToolTag(
  buffer: string,
  toolNames: string[]
): { index: number; name: string; selfClosing: boolean } {
  let bestIndex = -1;
  let bestName = "";
  let bestSelfClosing = false;

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

  return { index: bestIndex, name: bestName, selfClosing: bestSelfClosing };
}

export const yamlXmlProtocol = (
  _protocolOptions?: YamlXmlProtocolOptions
): ToolCallProtocol => {
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
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.input) as Record<string, unknown>;
      } catch {
        args = { value: toolCall.input };
      }
      const yamlContent = formatArgsAsYaml(args);
      return `<${toolCall.toolName}>\n${yamlContent}\n</${toolCall.toolName}>`;
    },

    formatToolResponse(toolResult: TCMCoreToolResult): string {
      let result = toolResult.result;

      if (
        result &&
        typeof result === "object" &&
        "type" in result &&
        (result as { type: unknown }).type === "json" &&
        "value" in result
      ) {
        result = (result as { value: unknown }).value;
      }

      const xml = xmlStringify(
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
          const textBefore = text.substring(currentIndex, tc.startIndex);
          if (textBefore.trim()) {
            processedElements.push({
              type: "text",
              text: textBefore,
            });
          }
        }

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

        currentIndex = tc.endIndex;
      }

      if (currentIndex < text.length) {
        const remaining = text.substring(currentIndex);
        if (remaining.trim()) {
          processedElements.push({
            type: "text",
            text: remaining,
          });
        }
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
        controller: TransformStreamDefaultController<TCMCoreStreamPart>,
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
        controller: TransformStreamDefaultController<TCMCoreStreamPart>,
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
        controller: TransformStreamDefaultController<TCMCoreStreamPart>
      ): void => {
        const maxTagLen = toolNames.length
          ? Math.max(...toolNames.map((n) => `<${n}>`.length))
          : 0;
        const tail = Math.max(0, maxTagLen - 1);
        const safeLen = Math.max(0, buffer.length - tail);
        if (safeLen > 0) {
          flushText(controller, buffer.slice(0, safeLen));
          buffer = buffer.slice(safeLen);
        }
      };

      const handleNewToolTag = (
        controller: TransformStreamDefaultController<TCMCoreStreamPart>,
        tagIndex: number,
        tagName: string,
        selfClosing: boolean
      ): void => {
        if (tagIndex > 0) {
          flushText(controller, buffer.substring(0, tagIndex));
        }

        if (selfClosing) {
          const selfTag = `<${tagName}/>`;
          buffer = buffer.substring(tagIndex + selfTag.length);
          processToolCallEnd(controller, "", tagName);
        } else {
          const startTag = `<${tagName}>`;
          buffer = buffer.substring(tagIndex + startTag.length);
          currentToolCall = { name: tagName, content: "" };
        }
      };

      const processBuffer = (
        controller: TransformStreamDefaultController<TCMCoreStreamPart>
      ) => {
        while (true) {
          if (currentToolCall) {
            const toolName = currentToolCall.name;
            const endTag = `</${toolName}>`;
            if (!handlePendingToolCall(controller, endTag, toolName)) {
              break;
            }
          } else {
            const { index, name, selfClosing } = findEarliestToolTag(
              buffer,
              toolNames
            );

            if (index === -1) {
              flushSafeText(controller);
              break;
            }

            handleNewToolTag(controller, index, name, selfClosing);
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
            chunk.textDelta ??
            (chunk as unknown as { delta?: string }).delta ??
            "";
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

/**
 * Default system prompt template for Orchestrator-style YAML+XML tool calling.
 */
export function orchestratorSystemPromptTemplate(
  tools: string,
  includeMultilineExample = true
): string {
  const multilineExample = includeMultilineExample
    ? `

For multiline values, use YAML's literal block syntax:
<write_file>
file_path: /tmp/example.txt
contents: |
  First line
  Second line
  Third line
</write_file>`
    : "";

  return `# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>${tools}</tools>

# Format

Use exactly one XML element whose tag name is the function name.
Inside the XML element, specify parameters using YAML syntax (key: value pairs).

# Example
<get_weather>
location: New York
unit: celsius
</get_weather>${multilineExample}

# Rules
- Parameter names and values must follow the schema exactly.
- Use proper YAML syntax for values (strings, numbers, booleans, arrays, objects).
- Each required parameter must appear once.
- Do not add functions or parameters not in the schema.
- After calling a tool, you will receive a response. Use this result to answer the user.`;
}
