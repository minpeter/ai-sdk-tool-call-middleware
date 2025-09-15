import type {
  LanguageModelV2Content,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";

import { escapeRegExp, getPotentialStartIndexMultiple, RJSON } from "@/utils";

import { ToolCallProtocol } from "./tool-call-protocol";

type JsonMixOptions = {
  toolCallStart?: string | string[];
  toolCallEnd?: string | string[];
  toolResponseStart?: string;
  toolResponseEnd?: string;
};

// Helper functions to normalize tag options
function normalizeToolCallTag(tag: string | string[] | undefined, defaultValue: string): string[] {
  if (!tag) return [defaultValue];
  return Array.isArray(tag) ? tag : [tag];
}

function normalizeToolResponseTag(tag: string | undefined, defaultValue: string): string {
  return tag ?? defaultValue;
}

function getFirstTag(tags: string[]): string {
  return tags[0];
}

export const jsonMixProtocol = ({
  toolCallStart = "<tool_call>",
  toolCallEnd = "</tool_call>",
  toolResponseStart = "<tool_response>",
  toolResponseEnd = "</tool_response>",
}: JsonMixOptions = {}): ToolCallProtocol => {
  // Normalize tag options
  const toolCallStartTags = normalizeToolCallTag(toolCallStart, "<tool_call>");
  const toolCallEndTags = normalizeToolCallTag(toolCallEnd, "</tool_call>");
  const toolResponseStartTag = normalizeToolResponseTag(toolResponseStart, "<tool_response>");
  const toolResponseEndTag = normalizeToolResponseTag(toolResponseEnd, "</tool_response>");

  // Use first tag for formatting
  const toolCallStartTag = getFirstTag(toolCallStartTags);
  const toolCallEndTag = getFirstTag(toolCallEndTags);

  return {
  formatTools({ tools, toolSystemPromptTemplate }) {
    const toolsForPrompt = (tools || [])
      .filter(tool => tool.type === "function")
      .map(tool => ({
        name: tool.name,
        description:
          tool.type === "function" && typeof tool.description === "string"
            ? tool.description
            : undefined,
        parameters: tool.inputSchema,
      }));
    return toolSystemPromptTemplate(JSON.stringify(toolsForPrompt));
  },

  formatToolCall(toolCall: LanguageModelV2ToolCall) {
    let args: unknown = {};
    try {
      args = JSON.parse(toolCall.input);
    } catch {
      args = toolCall.input;
    }
    return `${toolCallStartTag}${JSON.stringify({
      name: toolCall.toolName,
      arguments: args,
    })}${toolCallEndTag}`;
  },

  formatToolResponse(toolResult: LanguageModelV2ToolResultPart) {
    return `${toolResponseStartTag}${JSON.stringify({
      toolName: toolResult.toolName,
      result: toolResult.output,
    })}${toolResponseEndTag}`;
  },

  parseGeneratedText({ text, options }) {
    // Create regex pattern that matches any of the start tags followed by content and any of the end tags
    const startPattern = toolCallStartTags.map(escapeRegExp).join('|');
    const endPattern = toolCallEndTags.map(escapeRegExp).join('|');
    const toolCallRegex = new RegExp(
      `(${startPattern})([\u0000-\uFFFF]*?)(${endPattern})`,
      "gs"
    );

    const processedElements: LanguageModelV2Content[] = [];
    let currentIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = toolCallRegex.exec(text)) !== null) {
      const startIndex = match.index;
      const toolCallJson = match[2];

      if (startIndex > currentIndex) {
        const textSegment = text.substring(currentIndex, startIndex);
        if (textSegment.trim()) {
          processedElements.push({ type: "text", text: textSegment });
        }
      }

      if (toolCallJson) {
        try {
          const parsedToolCall = RJSON.parse(toolCallJson) as {
            name: string;
            arguments: unknown;
          };
          processedElements.push({
            type: "tool-call",
            toolCallId: generateId(),
            toolName: parsedToolCall.name,
            input: JSON.stringify(parsedToolCall.arguments ?? {}),
          });
        } catch (error) {
          if (options?.onError) {
            options.onError(
              "Could not process JSON tool call, keeping original text.",
              { toolCall: match[0], error }
            );
          }
          processedElements.push({ type: "text", text: match[0] });
        }
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

  createStreamParser({ tools: _tools, options } = { tools: [] }) {
    let isInsideToolCall = false;
    let buffer = "";
    let currentToolCallJson = "";
    let currentTextId: string | null = null;
    let hasEmittedTextStart = false;
    let currentStartTag = "";

    return new TransformStream({
      transform(chunk, controller) {
        if (chunk.type === "finish") {
          if (isInsideToolCall && buffer.length > 0) {
            if (!currentTextId) {
              currentTextId = generateId();
              controller.enqueue({ type: "text-start", id: currentTextId });
              hasEmittedTextStart = true;
            }
            controller.enqueue({
              type: "text-delta",
              id: currentTextId,
              delta: `${currentStartTag}${buffer}`,
            });
            buffer = "";
          } else if (!isInsideToolCall && buffer.length > 0) {
            // Flush any remaining buffered text (e.g., partial start tag suffix)
            if (!currentTextId) {
              currentTextId = generateId();
              controller.enqueue({ type: "text-start", id: currentTextId });
              hasEmittedTextStart = true;
            }
            controller.enqueue({
              type: "text-delta",
              id: currentTextId,
              delta: buffer,
            });
            buffer = "";
          }

          if (currentTextId && hasEmittedTextStart) {
            controller.enqueue({ type: "text-end", id: currentTextId });
            currentTextId = null;
            hasEmittedTextStart = false;
          }

          // No pending calls should remain; if there is leftover, emit as text
          if (currentToolCallJson) {
            const errorId = generateId();
            controller.enqueue({ type: "text-start", id: errorId });
            controller.enqueue({
              type: "text-delta",
              id: errorId,
              delta: `${currentStartTag}${currentToolCallJson}`,
            });
            controller.enqueue({ type: "text-end", id: errorId });
            currentToolCallJson = "";
          }

          controller.enqueue(chunk);
          return;
        }

        if (chunk.type !== "text-delta") {
          controller.enqueue(chunk);
          return;
        }

        buffer += chunk.delta;

        const publish = (text: string) => {
          if (isInsideToolCall) {
            if (currentTextId && hasEmittedTextStart) {
              controller.enqueue({ type: "text-end", id: currentTextId });
              currentTextId = null;
              hasEmittedTextStart = false;
            }
            currentToolCallJson += text;
          } else if (text.length > 0) {
            if (!currentTextId) {
              currentTextId = generateId();
              controller.enqueue({ type: "text-start", id: currentTextId });
              hasEmittedTextStart = true;
            }
            controller.enqueue({
              type: "text-delta",
              id: currentTextId,
              delta: text,
            });
          }
        };

        let searchTags = isInsideToolCall ? toolCallEndTags : toolCallStartTags;
        let matchInfo = getPotentialStartIndexMultiple(buffer, searchTags);
        
        while (matchInfo) {
          const { index: startIndex, matchedText: tag, isComplete } = matchInfo;
          
          if (!isComplete) {
            // Partial match found - keep the partial match in buffer
            break;
          }

          publish(buffer.slice(0, startIndex));
          buffer = buffer.slice(startIndex + tag.length);
          
          // Toggle state and finalize/initialize as needed
          if (!isInsideToolCall) {
            // We just consumed a start tag; begin accumulating JSON
            currentToolCallJson = "";
            currentStartTag = tag;
            isInsideToolCall = true;
          } else {
            // We just consumed an end tag; parse and emit tool-call
            try {
              const parsedToolCall = RJSON.parse(currentToolCallJson) as {
                name: string;
                arguments: unknown;
              };
              // close any open text block before emitting tool-call
              if (currentTextId && hasEmittedTextStart) {
                controller.enqueue({ type: "text-end", id: currentTextId });
                currentTextId = null;
                hasEmittedTextStart = false;
              }
              controller.enqueue({
                type: "tool-call",
                toolCallId: generateId(),
                toolName: parsedToolCall.name,
                input: JSON.stringify(parsedToolCall.arguments ?? {}),
              });
            } catch {
              const errorId = generateId();
              controller.enqueue({ type: "text-start", id: errorId });
              controller.enqueue({
                type: "text-delta",
                id: errorId,
                delta: `${currentStartTag}${currentToolCallJson}${tag}`,
              });
              controller.enqueue({ type: "text-end", id: errorId });
              if (options?.onError) {
                options.onError(
                  "Could not process streaming JSON tool call; emitting original text.",
                  {
                    toolCall: `${currentStartTag}${currentToolCallJson}${tag}`,
                  }
                );
              }
            }
            currentToolCallJson = "";
            currentStartTag = "";
            isInsideToolCall = false;
          }
          
          // Check for more matches
          searchTags = isInsideToolCall ? toolCallEndTags : toolCallStartTags;
          matchInfo = getPotentialStartIndexMultiple(buffer, searchTags);
        }

        if (!isInsideToolCall) {
          // Avoid emitting a partial start tag that may be completed in the next chunk.
          // If the buffer ends with a suffix that matches the beginning of any start tag,
          // keep that suffix in the buffer and only emit the safe prefix.
          const potentialMatch = getPotentialStartIndexMultiple(buffer, toolCallStartTags);
          if (potentialMatch && !potentialMatch.isComplete) {
            const suffix = buffer.slice(potentialMatch.index);
            
            // Special case: if we have `` (two backticks) as partial match for ```tool_call\n,
            // and there's a space after it (indicating it won't complete), consume the ``
            if (suffix === "``" && buffer.length > potentialMatch.index + 2 && 
                buffer[potentialMatch.index + 2] === " " &&
                toolCallStartTags.some(tag => tag.startsWith("```"))) {
              // Consume the `` and emit the rest
              const afterMatch = buffer.slice(potentialMatch.index + 2);
              publish(afterMatch);
              buffer = "";
            } else {
              // Emit only the safe portion before the potential (incomplete) start tag.
              publish(buffer.slice(0, potentialMatch.index));
              buffer = buffer.slice(potentialMatch.index);
            }
          } else {
            publish(buffer);
            buffer = "";
          }
        }
      },
    });
  },

  extractToolCallSegments({ text }) {
    const startPattern = toolCallStartTags.map(escapeRegExp).join('|');
    const endPattern = toolCallEndTags.map(escapeRegExp).join('|');
    const regex = new RegExp(`(${startPattern})([\u0000-\uFFFF]*?)(${endPattern})`, "gs");
    const segments: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) != null) {
      segments.push(m[0]);
    }
    return segments;
  },
  };
};
