import type {
  LanguageModelV2StreamPart,
  LanguageModelV2,
  LanguageModelV2Usage,
  LanguageModelV2FinishReason,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import { getPotentialStartIndex, RJSON } from "./utils";

export async function normalToolStream({
  doStream,
  toolCallTag,
  toolCallEndTag,
}: {
  doStream: () => ReturnType<LanguageModelV2["doStream"]>;
  toolCallTag: string;
  toolCallEndTag: string;
}) {
  const { stream, ...rest } = await doStream();

  let isFirstToolCall = true;
  let isFirstText = true;
  let afterSwitch = false;
  let isToolCall = false;
  let buffer = "";

  let toolCallIndex = -1;
  let toolCallBuffer: string[] = [];

  // Track text chunks for start/delta/end pattern
  let currentTextId: string | null = null;
  let hasEmittedTextStart = false;

  const transformStream = new TransformStream<
    LanguageModelV2StreamPart,
    LanguageModelV2StreamPart
  >({
    transform(chunk, controller) {
      if (chunk.type === "finish") {
        // End any active text chunk before processing tool calls
        if (currentTextId && hasEmittedTextStart) {
          controller.enqueue({
            type: "text-end",
            id: currentTextId,
          });
          currentTextId = null;
          hasEmittedTextStart = false;
        }

        if (toolCallBuffer.length > 0) {
          toolCallBuffer.forEach((toolCall) => {
            try {
              const parsedToolCall = RJSON.parse(toolCall) as {
                name: string;
                arguments: string;
              };

              controller.enqueue({
                type: "tool-call",
                toolCallId: generateId(),
                toolName: parsedToolCall.name,
                input: JSON.stringify(parsedToolCall.arguments),
              });
            } catch (e) {
              console.error(`Error parsing tool call: ${toolCall}`, e);

              // For error messages, use proper start/delta/end pattern
              const errorId = generateId();
              controller.enqueue({
                type: "text-start",
                id: errorId,
              });
              controller.enqueue({
                type: "text-delta",
                id: errorId,
                delta: `Failed to parse tool call: ${e}`,
              });
              controller.enqueue({
                type: "text-end",
                id: errorId,
              });
            }
          });
        }

        // stop token
        controller.enqueue(chunk);

        return;
      } else if (chunk.type !== "text-delta") {
        controller.enqueue(chunk);
        return;
      }

      buffer += chunk.delta;

      function publish(text: string) {
        if (text.length > 0) {
          const prefix =
            afterSwitch && (isToolCall ? !isFirstToolCall : !isFirstText)
              ? "\n" // separator
              : "";

          if (isToolCall) {
            // End any active text chunk when switching to tool call
            if (currentTextId && hasEmittedTextStart) {
              controller.enqueue({
                type: "text-end",
                id: currentTextId,
              });
              currentTextId = null;
              hasEmittedTextStart = false;
            }

            if (!toolCallBuffer[toolCallIndex]) {
              toolCallBuffer[toolCallIndex] = "";
            }

            toolCallBuffer[toolCallIndex] += text;
          } else {
            // Start a new text chunk if needed
            if (!currentTextId) {
              currentTextId = generateId();
              controller.enqueue({
                type: "text-start",
                id: currentTextId,
              });
              hasEmittedTextStart = true;
            }

            controller.enqueue({
              type: "text-delta",
              id: currentTextId,
              delta: prefix + text,
            });
          }

          afterSwitch = false;

          if (isToolCall) {
            isFirstToolCall = false;
          } else {
            isFirstText = false;
          }
        }
      }

      do {
        const nextTag = isToolCall ? toolCallEndTag : toolCallTag;
        const startIndex = getPotentialStartIndex(buffer, nextTag);

        // no opening or closing tag found, publish the buffer
        if (startIndex == null) {
          publish(buffer);
          buffer = "";
          break;
        }


        const foundFullMatch = startIndex + nextTag.length <= buffer.length;

        if (foundFullMatch) {
          // publish text before the tag
          publish(buffer.slice(0, startIndex));

          buffer = buffer.slice(startIndex + nextTag.length);
          toolCallIndex++;
          isToolCall = !isToolCall;
          afterSwitch = true;
        } else {
          // Partial match found, wait for more data to complete the tag.
          break;
        }
      } while (true);
    },
  });

  return {
    stream: stream.pipeThrough(transformStream),
    ...rest,
  };
}

// TODO: Modify tool calls to be streamed
export async function toolChoiceStream({
  doGenerate,
}: {
  doGenerate: () => ReturnType<LanguageModelV2["doGenerate"]>;
}) {
  const result = await doGenerate();

  // Assume result.content[0] contains tool-call information (JSON)
  const toolJson: any =
    result.content[0].type === "text" ? JSON.parse(result.content[0].text) : {};

  const toolCallChunk: LanguageModelV2StreamPart = {
    type: "tool-call",
    toolCallId: generateId(),
    toolName: toolJson.name,
    input: JSON.stringify(toolJson.arguments || {}),
  };

  const finishChunk: LanguageModelV2StreamPart = {
    type: "finish",
    usage: result.usage as LanguageModelV2Usage,
    finishReason: "tool-calls" as LanguageModelV2FinishReason,
  };

  const stream = new ReadableStream<LanguageModelV2StreamPart>({
    start(controller) {
      controller.enqueue(toolCallChunk);
      controller.enqueue(finishChunk);
      controller.close();
    },
  });

  return {
    request: result.request,
    response: result.response,
    stream,
  };
}
