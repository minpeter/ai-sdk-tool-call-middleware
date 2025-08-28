import {
  LanguageModelV2Content,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider";
import { ToolCallProtocol } from "./tool-call-protocol";
import { generateId } from "@ai-sdk/provider-utils";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import { escapeRegExp } from "../utils";
import { hasInputProperty } from "../utils";

function unwrapJsonSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as Record<string, unknown>;
  if (s.jsonSchema && typeof s.jsonSchema === "object") {
    return unwrapJsonSchema(s.jsonSchema);
  }
  return schema;
}

function getSchemaType(schema: unknown): string | undefined {
  const unwrapped = unwrapJsonSchema(schema);
  if (!unwrapped || typeof unwrapped !== "object") return undefined;
  const t: unknown = (unwrapped as Record<string, unknown>).type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    // Prefer specific primitive/object/array types if present
    const preferred = [
      "object",
      "array",
      "boolean",
      "number",
      "integer",
      "string",
    ];
    for (const p of preferred) if (t.includes(p)) return p;
  }
  // Heuristic: infer from shape when `type` is not explicitly provided
  const s = unwrapped as Record<string, unknown>;
  if (s && typeof s === "object" && (s.properties || s.additionalProperties)) {
    return "object";
  }
  if (s && typeof s === "object" && (s.items || s.prefixItems)) {
    return "array";
  }
  return undefined;
}

function coerceBySchema(value: unknown, schema?: unknown): unknown {
  const unwrapped = unwrapJsonSchema(schema);
  if (!unwrapped || typeof unwrapped !== "object") {
    if (typeof value === "string") {
      const s = value.trim();
      const lower = s.toLowerCase();
      if (lower === "true") return true;
      if (lower === "false") return false;
      if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) {
        const num = Number(s);
        if (Number.isFinite(num)) return num;
      }
    }
    return value;
  }
  const schemaType = getSchemaType(unwrapped);
  // If schema expects object/array but we got a string, try to parse
  if (typeof value === "string") {
    const s = value.trim();
    if (schemaType === "object") {
      try {
        // Accept JSON-like strings (including single quotes by relaxing)
        const normalized = s.replace(/^\{\s*\}$/s, "{}").replace(/'/g, '"');
        const obj = JSON.parse(normalized);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          const props = (unwrapped as Record<string, unknown>).properties as
            | Record<string, unknown>
            | undefined;
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
            const propSchema = props ? (props[k] as unknown) : undefined;
            out[k] =
              typeof propSchema === "boolean"
                ? v
                : coerceBySchema(v, propSchema);
          }
          return out;
        }
      } catch {
        // fall through
      }
    }
    if (schemaType === "array") {
      // Try JSON first
      try {
        const normalized = s.replace(/'/g, '"');
        const arr = JSON.parse(normalized);
        if (Array.isArray(arr)) {
          const u = unwrapped as Record<string, unknown>;
          const prefixItems = Array.isArray(u.prefixItems)
            ? (u.prefixItems as unknown[])
            : undefined;
          const itemsSchema = u.items as unknown;
          if (prefixItems && arr.length === prefixItems.length) {
            return arr.map((v, i) => coerceBySchema(v, prefixItems[i]));
          }
          return arr.map(v => coerceBySchema(v, itemsSchema));
        }
      } catch {
        // Fallbacks: CSV or newline separated numbers/strings
        const csv = s.includes("\n") ? s.split(/\n+/) : s.split(/,\s*/);
        const trimmed = csv.map(x => x.trim()).filter(x => x.length > 0);
        const u = unwrapped as Record<string, unknown>;
        const prefixItems = Array.isArray(u.prefixItems)
          ? (u.prefixItems as unknown[])
          : undefined;
        const itemsSchema = u.items as unknown;
        if (prefixItems && trimmed.length === prefixItems.length) {
          return trimmed.map((x, i) => coerceBySchema(x, prefixItems[i]));
        }
        return trimmed.map(x => coerceBySchema(x, itemsSchema));
      }
    }
  }
  if (
    schemaType === "object" &&
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const out: Record<string, unknown> = {};
    const props = (unwrapped as Record<string, unknown>).properties as
      | Record<string, unknown>
      | undefined;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const propSchema = props ? (props[k] as unknown) : undefined;
      // JSON Schema allows property schema to be boolean; ignore boolean schemas
      out[k] =
        typeof propSchema === "boolean" ? v : coerceBySchema(v, propSchema);
    }
    return out;
  }
  if (schemaType === "array") {
    const u = unwrapped as Record<string, unknown>;
    const itemsSchema = u.items as unknown;
    const prefixItems = Array.isArray(u.prefixItems)
      ? (u.prefixItems as unknown[])
      : undefined;
    if (Array.isArray(value)) {
      if (prefixItems && value.length === prefixItems.length) {
        return value.map((v, i) => coerceBySchema(v, prefixItems[i]));
      }
      return value.map(v => coerceBySchema(v, itemsSchema));
    }
    // Handle XML form: { item: [...] } or { item: single }
    if (value && typeof value === "object") {
      const maybe = value as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(maybe, "item")) {
        const items = maybe.item as unknown;
        const arr = Array.isArray(items) ? items : [items];
        if (prefixItems && arr.length === prefixItems.length) {
          return arr.map((v, i) => coerceBySchema(v, prefixItems[i]));
        }
        return arr.map(v => coerceBySchema(v, itemsSchema));
      }
      // Heuristic: object with numeric-like keys → treat as tuple/array
      const keys = Object.keys(maybe);
      if (keys.length > 0 && keys.every(k => /^\d+$/.test(k))) {
        const arr = keys
          .sort((a, b) => Number(a) - Number(b))
          .map(k => maybe[k]);
        if (prefixItems && arr.length === prefixItems.length) {
          return arr.map((v, i) => coerceBySchema(v, prefixItems[i]));
        }
        return arr.map(v => coerceBySchema(v, itemsSchema));
      }
    }
    // Heuristic: wrap single primitive into array when schema expects array
    if (
      value == null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      if (prefixItems && prefixItems.length > 0) {
        return [coerceBySchema(value, prefixItems[0])];
      }
      return [coerceBySchema(value, itemsSchema)];
    }
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (schemaType === "boolean") {
      const lower = s.toLowerCase();
      if (lower === "true") return true;
      if (lower === "false") return false;
    }
    if (schemaType === "number" || schemaType === "integer") {
      if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) {
        const num = Number(s);
        if (Number.isFinite(num)) return num;
      }
    }
  }
  return value;
}

export const xmlProtocol = (): ToolCallProtocol => ({
  formatTools({ tools, toolSystemPromptTemplate }) {
    const toolsForPrompt = (tools || []).map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: unwrapJsonSchema(tool.inputSchema),
    }));
    return toolSystemPromptTemplate(JSON.stringify(toolsForPrompt));
  },

  formatToolCall(toolCall: LanguageModelV2ToolCall): string {
    const builder = new XMLBuilder({ format: true, suppressEmptyNode: true });
    // Some providers pass JSON string; some runtime paths may provide an object
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
    const xmlContent = builder.build({
      [toolCall.toolName]: args,
    });
    return xmlContent;
  },

  formatToolResponse(toolResult: LanguageModelV2ToolResultPart): string {
    const builder = new XMLBuilder({ format: true });
    const xmlContent = builder.build({
      tool_response: {
        tool_name: toolResult.toolName,
        result: toolResult.output,
      },
    });
    return xmlContent;
  },

  parseGeneratedText({ text, tools, options }) {
    // Schema-based coercion: convert string primitives according to tool JSON schema types

    const toolNames = tools.map(t => t.name).filter(name => name != null);
    if (toolNames.length === 0) {
      return [{ type: "text", text }];
    }

    const toolNamesPattern = toolNames.map(n => escapeRegExp(n)).join("|");
    const toolCallRegex = new RegExp(
      String.raw`<(${toolNamesPattern})>([\s\S]*?)<\/\1>`,
      "g"
    );

    const processedElements: LanguageModelV2Content[] = [];
    let currentIndex = 0;
    let match;

    while ((match = toolCallRegex.exec(text)) !== null) {
      const startIndex = match.index;
      const toolName = match[1];
      const toolContent = match[2].trim();

      if (startIndex > currentIndex) {
        const textSegment = text.substring(currentIndex, startIndex);
        if (textSegment.trim()) {
          processedElements.push({ type: "text", text: textSegment });
        }
      }

      try {
        const parser = new XMLParser({
          ignoreAttributes: false,
          parseTagValue: false,
          ignoreDeclaration: true,
          textNodeName: "#text",
        });
        const parsedArgs =
          parser.parse(`<root>${toolContent}</root>`)?.root || {};

        const args: Record<string, unknown> = {};
        for (const k of Object.keys(parsedArgs || {})) {
          const v = parsedArgs[k];
          let val: unknown = v;
          if (
            v &&
            typeof v === "object" &&
            Object.prototype.hasOwnProperty.call(v, "#text")
          ) {
            val = (v as Record<string, unknown>)?.["#text"];
          }
          args[k] = typeof val === "string" ? val.trim() : val;
        }

        const schema = tools.find(t => t.name === toolName)
          ?.inputSchema as unknown;
        const coercedArgs = coerceBySchema(args, schema) as Record<
          string,
          unknown
        >;

        processedElements.push({
          type: "tool-call",
          toolCallId: generateId(),
          toolName,
          input: JSON.stringify(coercedArgs),
        });
      } catch (error) {
        const message = `Could not process XML tool call, keeping original text: ${match[0]}`;
        options?.onError?.(message, { toolCall: match[0], toolName, error });
        processedElements.push({ type: "text", text: match[0] });
      }

      currentIndex = startIndex + match[0].length;
    }

    if (currentIndex < text.length) {
      const remainingText = text.substring(currentIndex);
      if (remainingText.trim()) {
        processedElements.push({ type: "text", text: remainingText });
      }
    }

    return processedElements;
  },

  createStreamParser({ tools, options }) {
    const toolNames = tools.map(t => t.name).filter(name => name != null);
    let buffer = "";
    let currentToolCall: { name: string; content: string } | null = null;
    let currentTextId: string | null = null;

    const flushText = (
      controller: TransformStreamDefaultController,
      text?: string
    ) => {
      const content = text ?? buffer;
      if (content) {
        if (!currentTextId) {
          currentTextId = generateId();
          controller.enqueue({ type: "text-start", id: currentTextId });
        }
        controller.enqueue({
          type: "text-delta",
          id: currentTextId,
          delta: content,
        });
        // Only clear the internal buffer when we are flushing the buffer itself.
        // When flushing an explicit slice (textBeforeTag), keep buffer intact so
        // subsequent substring operations use the original indices.
        if (text === undefined) {
          buffer = "";
        }
      }

      if (currentTextId && !text) {
        controller.enqueue({ type: "text-end", id: currentTextId });
        currentTextId = null;
      }
    };

    return new TransformStream({
      transform(chunk, controller) {
        if (chunk.type !== "text-delta") {
          if (buffer) flushText(controller);
          controller.enqueue(chunk);
          return;
        }

        buffer += chunk.delta;

        while (true) {
          if (currentToolCall) {
            const endTag = `</${currentToolCall.name}>`;
            const endTagIndex = buffer.indexOf(endTag);

            if (endTagIndex !== -1) {
              const toolContent = buffer.substring(0, endTagIndex);
              buffer = buffer.substring(endTagIndex + endTag.length);

              try {
                const parser = new XMLParser({
                  ignoreAttributes: false,
                  parseTagValue: false,
                  ignoreDeclaration: true,
                  textNodeName: "#text",
                });
                const parsedArgs =
                  parser.parse(`<root>${toolContent}</root>`)?.root || {};

                const args: Record<string, unknown> = {};
                for (const k of Object.keys(parsedArgs || {})) {
                  const v = parsedArgs[k];
                  let val: unknown = v;
                  if (
                    v &&
                    typeof v === "object" &&
                    Object.prototype.hasOwnProperty.call(v, "#text")
                  ) {
                    val = (v as Record<string, unknown>)?.["#text"];
                  }
                  args[k] = typeof val === "string" ? val.trim() : val;
                }

                const toolSchema = tools.find(
                  t => t.name === currentToolCall!.name
                )?.inputSchema;
                const coercedArgs = coerceBySchema(args, toolSchema) as Record<
                  string,
                  unknown
                >;

                flushText(controller);
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: generateId(),
                  toolName: currentToolCall.name,
                  input: JSON.stringify(coercedArgs),
                });
              } catch {
                const originalCallText = `<${currentToolCall.name}>${toolContent}${endTag}`;
                if (options?.onError) {
                  options.onError(
                    "Could not process streaming XML tool call; emitting original text.",
                    {
                      toolCall: originalCallText,
                      toolName: currentToolCall.name,
                    }
                  );
                }
                flushText(controller, originalCallText);
              }
              currentToolCall = null;
            } else {
              break;
            }
          } else {
            let earliestStartTagIndex = -1;
            let earliestToolName = "";

            if (toolNames.length > 0) {
              for (const name of toolNames) {
                const startTag = `<${name}>`;
                const index = buffer.indexOf(startTag);
                if (
                  index !== -1 &&
                  (earliestStartTagIndex === -1 ||
                    index < earliestStartTagIndex)
                ) {
                  earliestStartTagIndex = index;
                  earliestToolName = name;
                }
              }
            }

            if (earliestStartTagIndex !== -1) {
              const textBeforeTag = buffer.substring(0, earliestStartTagIndex);
              flushText(controller, textBeforeTag);

              const startTag = `<${earliestToolName}>`;
              buffer = buffer.substring(
                earliestStartTagIndex + startTag.length
              );
              currentToolCall = { name: earliestToolName, content: "" };
            } else {
              break;
            }
          }
        }
      },
      flush(controller) {
        if (currentToolCall) {
          const unfinishedCall = `<${currentToolCall.name}>${buffer}`;
          flushText(controller, unfinishedCall);
        } else if (buffer) {
          flushText(controller);
        }

        if (currentTextId) {
          controller.enqueue({ type: "text-end", id: currentTextId });
        }
      },
    });
  },
});
