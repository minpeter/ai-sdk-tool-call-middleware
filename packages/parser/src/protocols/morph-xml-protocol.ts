import {
  LanguageModelV2Content,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import * as RXML from "@ai-sdk-tool/rxml";

import { hasInputProperty } from "@/utils";
import { unwrapJsonSchema } from "@/utils/coercion";

import { ToolCallProtocol } from "./tool-call-protocol";

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

//

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
    return RXML.stringify(toolCall.toolName, args, {
      suppressEmptyNode: false,
      format: false,
    });
  },

  formatToolResponse(toolResult: LanguageModelV2ToolResultPart): string {
    return RXML.stringify("tool_response", {
      tool_name: toolResult.toolName,
      result: toolResult.output,
    });
  },

  parseGeneratedText({ text, tools, options }) {
    const originalSchemas =
      (options as { originalToolSchemas?: Record<string, unknown> } | undefined)
        ?.originalToolSchemas || {};

    const toolNames = tools.map(t => t.name).filter(name => name != null);
    if (toolNames.length === 0) {
      return [{ type: "text", text }];
    }

    const processedElements: LanguageModelV2Content[] = [];
    let currentIndex = 0;

    // Find all tool calls using proper XML parsing
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
        const tagStart = text.indexOf(startTag, searchIndex);
        if (tagStart === -1) break;

        // Use findFirstTopLevelRange to get the proper content
        const remainingText = text.substring(tagStart);
        const range = RXML.findFirstTopLevelRange(remainingText, toolName);
        if (range) {
          const fullTagStart = tagStart;
          const contentStart = tagStart + startTag.length;
          const contentEnd = contentStart + (range.end - range.start);
          const fullTagEnd = contentEnd + `</${toolName}>`.length;

          const toolContent = text.substring(contentStart, contentEnd);

          toolCalls.push({
            toolName,
            startIndex: fullTagStart,
            endIndex: fullTagEnd,
            content: toolContent,
          });

          searchIndex = fullTagEnd;
        } else {
          searchIndex = tagStart + startTag.length;
        }
      }
    }

    // Sort tool calls by start index
    toolCalls.sort((a, b) => a.startIndex - b.startIndex);

    // Process text and tool calls in order
    for (const toolCall of toolCalls) {
      // Add text before this tool call
      if (toolCall.startIndex > currentIndex) {
        const textSegment = text.substring(currentIndex, toolCall.startIndex);
        if (textSegment.trim()) {
          processedElements.push({ type: "text", text: textSegment });
        }
      }

      try {
        const toolSchema = getToolSchema(
          tools,
          originalSchemas,
          toolCall.toolName
        );
        const parsed = RXML.parse(toolCall.content, toolSchema, {
          onError: options?.onError,
        });

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
        const message = `Could not process XML tool call, keeping original text: ${originalCallText}`;
        options?.onError?.(message, {
          toolCall: originalCallText,
          toolName: toolCall.toolName,
          error,
        });
        processedElements.push({ type: "text", text: originalCallText });
      }

      currentIndex = toolCall.endIndex;
    }

    // Add remaining text
    if (currentIndex < text.length) {
      const remainingText = text.substring(currentIndex);
      if (remainingText.trim()) {
        processedElements.push({ type: "text", text: remainingText });
      }
    }

    return processedElements;
  },

  createStreamParser({ tools, options }) {
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
                const toolSchema = getToolSchema(
                  tools,
                  originalSchemas,
                  currentToolCall!.name
                );
                const parsed = RXML.parse(toolContent, toolSchema, {
                  onError: options?.onError,
                });

                flushText(controller);
                controller.enqueue({
                  type: "tool-call",
                  toolCallId: generateId(),
                  toolName: currentToolCall.name,
                  input: JSON.stringify(parsed),
                });
              } catch (error) {
                const originalCallText = `<${currentToolCall.name}>${toolContent}${endTag}`;
                let message =
                  "Could not process streaming XML tool call; emitting original text.";
                if (error instanceof RXML.RXMLDuplicateStringTagError) {
                  message = `Duplicate string tags detected in streaming tool call '${currentToolCall.name}'; emitting original text.`;
                } else if (error instanceof RXML.RXMLCoercionError) {
                  message = `Failed to coerce arguments for streaming tool call '${currentToolCall.name}'; emitting original text.`;
                } else if (error instanceof RXML.RXMLParseError) {
                  message = `Failed to parse XML for streaming tool call '${currentToolCall.name}'; emitting original text.`;
                }
                options?.onError?.(message, {
                  toolCall: originalCallText,
                  toolName: currentToolCall.name,
                  error,
                });
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

    const toolCalls: Array<{ segment: string; startIndex: number }> = [];

    for (const toolName of toolNames) {
      let searchIndex = 0;
      while (searchIndex < text.length) {
        const startTag = `<${toolName}>`;
        const tagStart = text.indexOf(startTag, searchIndex);
        if (tagStart === -1) break;

        // Use findFirstTopLevelRange to get the proper content
        const remainingText = text.substring(tagStart);
        const range = RXML.findFirstTopLevelRange(remainingText, toolName);
        if (range) {
          const contentStart = tagStart + startTag.length;
          const contentEnd = contentStart + (range.end - range.start);
          const fullTagEnd = contentEnd + `</${toolName}>`.length;

          const fullSegment = text.substring(tagStart, fullTagEnd);
          toolCalls.push({ segment: fullSegment, startIndex: tagStart });

          searchIndex = fullTagEnd;
        } else {
          searchIndex = tagStart + startTag.length;
        }
      }
    }

    return toolCalls
      .sort((a, b) => a.startIndex - b.startIndex)
      .map(tc => tc.segment);
  },
});
