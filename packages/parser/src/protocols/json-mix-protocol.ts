import type {
  LanguageModelV2Content,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider";
import { ToolCallProtocol } from "./tool-call-protocol";
import { generateId } from "@ai-sdk/provider-utils";
import { getPotentialStartIndex, RJSON, escapeRegExp } from "../utils";

type JsonMixOptions = {
  toolCallStart?: string;
  toolCallEnd?: string;
  toolResponseStart?: string;
  toolResponseEnd?: string;
};

export const jsonMixProtocol = ({
  toolCallStart = "<tool_call>",
  toolCallEnd = "</tool_call>",
  toolResponseStart = "<tool_response>",
  toolResponseEnd = "</tool_response>",
}: JsonMixOptions = {}): ToolCallProtocol => ({
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
    return `${toolCallStart}${JSON.stringify({
      name: toolCall.toolName,
      arguments: args,
    })}${toolCallEnd}`;
  },

  formatToolResponse(toolResult: LanguageModelV2ToolResultPart) {
    return `${toolResponseStart}${JSON.stringify({
      toolName: toolResult.toolName,
      result: toolResult.output,
    })}${toolResponseEnd}`;
  },

  parseGeneratedText({ text, options }) {
    const startEsc = escapeRegExp(toolCallStart);
    const endEsc = escapeRegExp(toolCallEnd);
    const toolCallRegex = new RegExp(
      `${startEsc}([\u0000-\uFFFF]*?)${endEsc}`,
      "gs"
    );

    const processedElements: LanguageModelV2Content[] = [];
    let currentIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = toolCallRegex.exec(text)) !== null) {
      const startIndex = match.index;
      const toolCallJson = match[1];

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
              delta: `${toolCallStart}${buffer}`,
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
              delta: `${toolCallStart}${currentToolCallJson}`,
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

        let startIndex: number | null | undefined;
        while (
          (startIndex = getPotentialStartIndex(
            buffer,
            isInsideToolCall ? toolCallEnd : toolCallStart
          )) != null
        ) {
          const tag = isInsideToolCall ? toolCallEnd : toolCallStart;
          if (startIndex + tag.length > buffer.length) {
            break;
          }

          publish(buffer.slice(0, startIndex));
          buffer = buffer.slice(startIndex + tag.length);
          // Toggle state and finalize/initialize as needed
          if (!isInsideToolCall) {
            // We just consumed a start tag; begin accumulating JSON
            currentToolCallJson = "";
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
                delta: `${toolCallStart}${currentToolCallJson}${toolCallEnd}`,
              });
              controller.enqueue({ type: "text-end", id: errorId });
              if (options?.onError) {
                options.onError(
                  "Could not process streaming JSON tool call; emitting original text.",
                  {
                    toolCall: `${toolCallStart}${currentToolCallJson}${toolCallEnd}`,
                  }
                );
              }
            }
            currentToolCallJson = "";
            isInsideToolCall = false;
          }
        }

        if (!isInsideToolCall) {
          // Avoid emitting a partial start tag that may be completed in the next chunk.
          // If the buffer ends with a suffix that matches the beginning of the start tag,
          // keep that suffix in the buffer and only emit the safe prefix.
          const potentialIndex = getPotentialStartIndex(buffer, toolCallStart);
          if (
            potentialIndex != null &&
            potentialIndex + toolCallStart.length > buffer.length
          ) {
            // Emit only the safe portion before the potential (incomplete) start tag.
            publish(buffer.slice(0, potentialIndex));
            buffer = buffer.slice(potentialIndex);
          } else {
            publish(buffer);
            buffer = "";
          }
        }
      },
    });
  },
});
