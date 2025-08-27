import type {
  LanguageModelV2Content,
  LanguageModelV2ToolCall,
  LanguageModelV2ToolResultPart,
} from "@ai-sdk/provider";
import { ToolCallProtocol } from "./tool-call-protocol";
import { generateId } from "@ai-sdk/provider-utils";
import { getPotentialStartIndex, RJSON } from "../utils";

type JsonMixOptions = {
  toolCallStart?: string;
  toolCallEnd?: string;
  toolResponseStart?: string;
  toolResponseEnd?: string;
};

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

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
    // Support legacy tag names by normalizing them to the configured ones.
    const legacyStart =
      toolCallStart === "<tool_call>" ? "<tool_code>" : "<tool_call>";
    const legacyEnd =
      toolCallEnd === "</tool_call>" ? "</tool_code>" : "</tool_call>";
    const normalizedText = text
      .replaceAll(legacyStart, toolCallStart)
      .replaceAll(legacyEnd, toolCallEnd);

    const startEsc = escapeForRegExp(toolCallStart);
    const endEsc = escapeForRegExp(toolCallEnd);
    const toolCallRegex = new RegExp(
      `${startEsc}([\u0000-\uFFFF]*?)${endEsc}`,
      "gs"
    );

    const processedElements: LanguageModelV2Content[] = [];
    let currentIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = toolCallRegex.exec(normalizedText)) !== null) {
      const startIndex = match.index;
      const toolCallJson = match[1];

      if (startIndex > currentIndex) {
        const textSegment = normalizedText.substring(currentIndex, startIndex);
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
        } catch {
          if (options?.onError) {
            options.onError(
              "Could not process JSON tool call, keeping original text.",
              { toolCall: match[0] }
            );
          }
          processedElements.push({ type: "text", text: match[0] });
        }
      }

      currentIndex = startIndex + match[0].length;
    }

    if (currentIndex < normalizedText.length) {
      const remainingText = normalizedText.substring(currentIndex);
      if (remainingText.trim()) {
        processedElements.push({ type: "text", text: remainingText });
      }
    }

    return processedElements;
  },

  createStreamParser({ tools: _tools, options } = { tools: [] }) {
    let isInsideToolCall = false;
    let buffer = "";
    const toolCallBuffer: string[] = [];
    let currentTextId: string | null = null;
    let hasEmittedTextStart = false;
    const legacyStart =
      toolCallStart === "<tool_call>" ? "<tool_code>" : "<tool_call>";
    const legacyEnd =
      toolCallEnd === "</tool_call>" ? "</tool_code>" : "</tool_call>";

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
          }

          if (currentTextId && hasEmittedTextStart) {
            controller.enqueue({ type: "text-end", id: currentTextId });
          }

          toolCallBuffer.forEach(toolCallText => {
            try {
              const parsedToolCall = RJSON.parse(toolCallText) as {
                name: string;
                arguments: unknown;
              };
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
                delta: `${toolCallStart}${toolCallText}${toolCallEnd}`,
              });
              controller.enqueue({ type: "text-end", id: errorId });
              if (options?.onError) {
                options.onError(
                  "Could not process streaming JSON tool call; emitting original text.",
                  { toolCall: `${toolCallStart}${toolCallText}${toolCallEnd}` }
                );
              }
            }
          });

          controller.enqueue(chunk);
          return;
        }

        if (chunk.type !== "text-delta") {
          controller.enqueue(chunk);
          return;
        }

        // Normalize legacy tag names to the configured ones for streaming parsing.
        const normalizedDelta = chunk.delta
          .replaceAll(legacyStart, toolCallStart)
          .replaceAll(legacyEnd, toolCallEnd);
        buffer += normalizedDelta;

        const publish = (text: string) => {
          if (isInsideToolCall) {
            if (currentTextId && hasEmittedTextStart) {
              controller.enqueue({ type: "text-end", id: currentTextId });
              currentTextId = null;
              hasEmittedTextStart = false;
            }
            toolCallBuffer.push(text);
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
          isInsideToolCall = !isInsideToolCall;
        }

        if (!isInsideToolCall) {
          publish(buffer);
          buffer = "";
        }
      },
    });
  },
});
