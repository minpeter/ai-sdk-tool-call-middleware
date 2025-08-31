import {
  LanguageModelV2Content,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import { XMLBuilder, XMLParser } from "fast-xml-parser";

import { escapeRegExp, hasInputProperty } from "@/utils";
import { coerceBySchema, unwrapJsonSchema } from "@/utils/coercion";

import { ToolCallProtocol } from "./tool-call-protocol";

// Helper to get unwrapped schema type string
function getSchemaTypeString(schema: unknown): string | undefined {
  const s = unwrapJsonSchema(schema);
  if (!s || typeof s !== "object") return undefined;
  const t = (s as Record<string, unknown>).type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
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
  return undefined;
}

function getToolSchema(
  tools: Array<{ name?: string; inputSchema?: unknown }>,
  originalSchemas: Record<string, unknown>,
  toolName: string
): unknown {
  const original = originalSchemas[toolName];
  if (original) return original;
  const fallback = tools.find(t => t.name === toolName)?.inputSchema;
  return fallback as unknown;
}

function getPropertySchema(toolSchema: unknown, key: string): unknown {
  const unwrapped = unwrapJsonSchema(toolSchema);
  if (!unwrapped || typeof unwrapped !== "object") return undefined;
  const u = unwrapped as Record<string, unknown>;
  const props = u.properties as Record<string, unknown> | undefined;
  if (props && Object.prototype.hasOwnProperty.call(props, key)) {
    return (props as Record<string, unknown>)[key];
  }
  return undefined;
}

function extractRawInner(
  xmlContent: string,
  tagName: string
): string | undefined {
  // Extract inner text of the first matching tag without parsing, preserving nested markup
  const tag = escapeRegExp(tagName);
  const regex = new RegExp(String.raw`<${tag}>([\s\S]*?)<\/${tag}>`);
  const m = regex.exec(xmlContent);
  return m ? m[1] : undefined;
}

export const morphXmlProtocol = (): ToolCallProtocol => ({
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
    const warnOnDuplicate: boolean = true;
    // Get original schemas from provider options if available
    const originalSchemas =
      (options as { originalToolSchemas?: Record<string, unknown> } | undefined)
        ?.originalToolSchemas || {};

    // Optional debug
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
        let cancelToolCall = false;
        // Determine tool schema for property-level decisions
        const toolSchema = getToolSchema(tools, originalSchemas, toolName);
        for (const k of Object.keys(parsedArgs || {})) {
          const v = parsedArgs[k];
          let val: unknown = v;

          // If schema says this property is a string, prefer raw inner content
          const propSchema = getPropertySchema(toolSchema, k);
          const propType = getSchemaTypeString(propSchema);
          if (propType === "string" && !Array.isArray(v)) {
            const raw = extractRawInner(toolContent, k);
            if (typeof raw === "string") {
              args[k] = raw; // do not trim or coerce raw string
              continue;
            }
          }

          // Handle text content extraction
          if (
            v &&
            typeof v === "object" &&
            Object.prototype.hasOwnProperty.call(v, "#text")
          ) {
            val = (v as Record<string, unknown>)?.["#text"];
          }

          // Heuristic array parsing for multiple tags with same name
          if (Array.isArray(v)) {
            if (propType === "string") {
              const mapped = v
                .map(item => {
                  if (
                    item &&
                    typeof item === "object" &&
                    Object.prototype.hasOwnProperty.call(item, "#text")
                  ) {
                    const textVal = (item as Record<string, unknown>)?.[
                      "#text"
                    ];
                    return typeof textVal === "string"
                      ? textVal
                      : String(textVal);
                  }
                  return typeof item === "string" ? item : String(item);
                })
                .filter(x => typeof x === "string");

              if (mapped.length > 1 && warnOnDuplicate) {
                options?.onError?.(
                  `Duplicate string tags for <${k}> detected; cancelling tool call`,
                  {
                    toolName,
                    toolCall: `<${toolName}>${toolContent}</${toolName}>`,
                  }
                );
              }

              if (mapped.length > 1) {
                cancelToolCall = true;
                break;
              } else {
                val = mapped[0] ?? "";
              }
            } else {
              val = v.map(item => {
                if (
                  item &&
                  typeof item === "object" &&
                  Object.prototype.hasOwnProperty.call(item, "#text")
                ) {
                  const textVal = (item as Record<string, unknown>)?.["#text"];
                  return typeof textVal === "string" ? textVal.trim() : textVal;
                }
                return typeof item === "string" ? item.trim() : item;
              });
            }
          }
          // Heuristic tuple/array parsing for various XML patterns
          else if (
            v &&
            typeof v === "object" &&
            !Object.prototype.hasOwnProperty.call(v, "#text")
          ) {
            const obj = v as Record<string, unknown>;
            const keys = Object.keys(obj);

            // Check for 'item' key pattern (common XML array pattern)
            if (keys.length === 1 && keys[0] === "item") {
              const itemValue = obj.item;
              if (Array.isArray(itemValue)) {
                val = itemValue.map(item => {
                  if (
                    item &&
                    typeof item === "object" &&
                    Object.prototype.hasOwnProperty.call(item, "#text")
                  ) {
                    const textVal = (item as Record<string, unknown>)?.[
                      "#text"
                    ];
                    const trimmed =
                      typeof textVal === "string" ? textVal.trim() : textVal;
                    // Try to convert to number if it looks like one
                    if (
                      typeof trimmed === "string" &&
                      /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)
                    ) {
                      const num = Number(trimmed);
                      if (Number.isFinite(num)) return num;
                    }
                    return trimmed;
                  }
                  const trimmed = typeof item === "string" ? item.trim() : item;
                  // Try to convert to number if it looks like one
                  if (
                    typeof trimmed === "string" &&
                    /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)
                  ) {
                    const num = Number(trimmed);
                    if (Number.isFinite(num)) return num;
                  }
                  return trimmed;
                });
              } else {
                const trimmed =
                  typeof itemValue === "string" ? itemValue.trim() : itemValue;
                // Try to convert to number if it looks like one
                if (
                  typeof trimmed === "string" &&
                  /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)
                ) {
                  const num = Number(trimmed);
                  if (Number.isFinite(num)) {
                    val = num;
                  } else {
                    val = trimmed;
                  }
                } else {
                  val = trimmed;
                }
              }
            }
            // Check if all keys are numeric indices (0, 1, 2, ...) and consecutive
            else {
              const isIndexedTuple =
                keys.length > 0 &&
                keys.every(key => /^\d+$/.test(key)) &&
                (() => {
                  const indices = keys
                    .map(k => parseInt(k))
                    .sort((a, b) => a - b);
                  return (
                    indices[0] === 0 && indices.every((val, idx) => val === idx)
                  );
                })();

              if (isIndexedTuple) {
                // Convert indexed object to array (tuple)
                const sortedKeys = keys.sort(
                  (a, b) => parseInt(a) - parseInt(b)
                );
                val = sortedKeys.map(key => {
                  const item = obj[key];
                  if (
                    item &&
                    typeof item === "object" &&
                    Object.prototype.hasOwnProperty.call(item, "#text")
                  ) {
                    const textVal = (item as Record<string, unknown>)?.[
                      "#text"
                    ];
                    return typeof textVal === "string"
                      ? textVal.trim()
                      : textVal;
                  }
                  return typeof item === "string" ? item.trim() : item;
                });
              } else {
                val = v;
              }
            }
          }

          if (cancelToolCall) {
            break;
          }
          args[k] = typeof val === "string" ? val.trim() : val;
        }

        if (cancelToolCall) {
          const originalCallText = match[0];
          options?.onError?.(
            `Duplicate string tags detected; cancelling tool call`,
            { toolCall: originalCallText, toolName }
          );
          processedElements.push({ type: "text", text: originalCallText });
        } else {
          // Use original schema if available, fallback to transformed schema
          // INTERNAL: `originalToolSchemas` is used to propagate the provider's
          // untouched tool schemas for better coercion. Not part of public API.
          const schema = toolSchema;

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
        }
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
    const warnOnDuplicate: boolean = true;
    // Get original schemas from options if available
    const originalSchemas =
      (options as { originalToolSchemas?: Record<string, unknown> } | undefined)
        ?.originalToolSchemas || {};
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
                let cancelToolCall = false;
                // Determine tool schema for property-level decisions
                const toolSchema = getToolSchema(
                  tools,
                  originalSchemas,
                  currentToolCall!.name
                );
                for (const k of Object.keys(parsedArgs || {})) {
                  const v = parsedArgs[k];
                  let val: unknown = v;

                  // If schema says this property is a string, prefer raw inner content
                  const propSchema = getPropertySchema(toolSchema, k);
                  const propType = getSchemaTypeString(propSchema);
                  if (propType === "string" && !Array.isArray(v)) {
                    const raw = extractRawInner(toolContent, k);
                    if (typeof raw === "string") {
                      args[k] = raw; // do not trim or coerce raw string
                      continue;
                    }
                  }

                  // Handle text content extraction
                  if (
                    v &&
                    typeof v === "object" &&
                    Object.prototype.hasOwnProperty.call(v, "#text")
                  ) {
                    val = (v as Record<string, unknown>)?.["#text"];
                  }

                  // Heuristic array parsing for multiple tags with same name
                  if (Array.isArray(v)) {
                    if (propType === "string") {
                      const mapped = v
                        .map(item => {
                          if (
                            item &&
                            typeof item === "object" &&
                            Object.prototype.hasOwnProperty.call(item, "#text")
                          ) {
                            const textVal = (item as Record<string, unknown>)?.[
                              "#text"
                            ];
                            return typeof textVal === "string"
                              ? textVal
                              : String(textVal);
                          }
                          return typeof item === "string" ? item : String(item);
                        })
                        .filter(x => typeof x === "string");

                      if (mapped.length > 1 && warnOnDuplicate) {
                        options?.onError?.(
                          `Duplicate string tags for <${k}> detected; cancelling tool call`,
                          {
                            toolName: currentToolCall!.name,
                            toolCall: `<${currentToolCall!.name}>${toolContent}</${currentToolCall!.name}>`,
                          }
                        );
                      }

                      if (mapped.length > 1) {
                        cancelToolCall = true;
                        break;
                      } else {
                        val = mapped[0] ?? "";
                      }
                    } else {
                      val = v.map(item => {
                        if (
                          item &&
                          typeof item === "object" &&
                          Object.prototype.hasOwnProperty.call(item, "#text")
                        ) {
                          const textVal = (item as Record<string, unknown>)?.[
                            "#text"
                          ];
                          return typeof textVal === "string"
                            ? textVal.trim()
                            : textVal;
                        }
                        return typeof item === "string" ? item.trim() : item;
                      });
                    }
                  }
                  // Heuristic tuple/array parsing for various XML patterns
                  else if (
                    v &&
                    typeof v === "object" &&
                    !Object.prototype.hasOwnProperty.call(v, "#text")
                  ) {
                    const obj = v as Record<string, unknown>;
                    const keys = Object.keys(obj);

                    // Check for 'item' key pattern (common XML array pattern)
                    if (keys.length === 1 && keys[0] === "item") {
                      const itemValue = obj.item;
                      if (Array.isArray(itemValue)) {
                        val = itemValue.map(item => {
                          if (
                            item &&
                            typeof item === "object" &&
                            Object.prototype.hasOwnProperty.call(item, "#text")
                          ) {
                            const textVal = (item as Record<string, unknown>)?.[
                              "#text"
                            ];
                            const trimmed =
                              typeof textVal === "string"
                                ? textVal.trim()
                                : textVal;
                            // Try to convert to number if it looks like one
                            if (
                              typeof trimmed === "string" &&
                              /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)
                            ) {
                              const num = Number(trimmed);
                              if (Number.isFinite(num)) return num;
                            }
                            return trimmed;
                          }
                          const trimmed =
                            typeof item === "string" ? item.trim() : item;
                          // Try to convert to number if it looks like one
                          if (
                            typeof trimmed === "string" &&
                            /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)
                          ) {
                            const num = Number(trimmed);
                            if (Number.isFinite(num)) return num;
                          }
                          return trimmed;
                        });
                      } else {
                        const trimmed =
                          typeof itemValue === "string"
                            ? itemValue.trim()
                            : itemValue;
                        // Try to convert to number if it looks like one
                        if (
                          typeof trimmed === "string" &&
                          /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)
                        ) {
                          const num = Number(trimmed);
                          if (Number.isFinite(num)) {
                            val = num;
                          } else {
                            val = trimmed;
                          }
                        } else {
                          val = trimmed;
                        }
                      }
                    }
                    // Check if all keys are numeric indices (0, 1, 2, ...) and consecutive
                    else {
                      const isIndexedTuple =
                        keys.length > 0 &&
                        keys.every(key => /^\d+$/.test(key)) &&
                        (() => {
                          const indices = keys
                            .map(k => parseInt(k))
                            .sort((a, b) => a - b);
                          return (
                            indices[0] === 0 &&
                            indices.every((val, idx) => val === idx)
                          );
                        })();

                      if (isIndexedTuple) {
                        // Convert indexed object to array (tuple)
                        const sortedKeys = keys.sort(
                          (a, b) => parseInt(a) - parseInt(b)
                        );
                        val = sortedKeys.map(key => {
                          const item = obj[key];
                          if (
                            item &&
                            typeof item === "object" &&
                            Object.prototype.hasOwnProperty.call(item, "#text")
                          ) {
                            const textVal = (item as Record<string, unknown>)?.[
                              "#text"
                            ];
                            return typeof textVal === "string"
                              ? textVal.trim()
                              : textVal;
                          }
                          return typeof item === "string" ? item.trim() : item;
                        });
                      } else {
                        val = v;
                      }
                    }
                  }

                  if (cancelToolCall) {
                    break;
                  }
                  args[k] = typeof val === "string" ? val.trim() : val;
                }

                if (cancelToolCall) {
                  const originalCallText = `<${currentToolCall.name}>${toolContent}</${currentToolCall.name}>`;
                  if (options?.onError) {
                    options.onError(
                      "Duplicate string tags detected; cancelling tool call",
                      {
                        toolCall: originalCallText,
                        toolName: currentToolCall.name,
                      }
                    );
                  }
                  flushText(controller, originalCallText);
                } else {
                  // Use original schema if available, fallback to transformed schema
                  const coercedArgs = coerceBySchema(
                    args,
                    toolSchema
                  ) as Record<string, unknown>;

                  flushText(controller);
                  controller.enqueue({
                    type: "tool-call",
                    toolCallId: generateId(),
                    toolName: currentToolCall.name,
                    input: JSON.stringify(coercedArgs),
                  });
                }
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

  extractToolCallSegments({ text, tools }) {
    const toolNames = tools.map(t => t.name).filter(Boolean) as string[];
    if (toolNames.length === 0) return [];
    const names = toolNames.map(n => escapeRegExp(String(n))).join("|");
    if (!names) return [];
    const regex = new RegExp(`<(${names})>[\\s\\S]*?<\\/\\1>`, "g");
    const segments: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) != null) {
      segments.push(m[0]);
    }
    return segments;
  },
});
