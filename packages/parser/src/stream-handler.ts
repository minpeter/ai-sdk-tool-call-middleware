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

  const transformStream = new TransformStream<
    LanguageModelV2StreamPart,
    LanguageModelV2StreamPart
  >({
    transform(chunk, controller) {
      if (chunk.type === "finish") {
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

              controller.enqueue({
                type: "text-delta",
                id: generateId(),
                delta: `Failed to parse tool call: ${e}`,
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
            if (!toolCallBuffer[toolCallIndex]) {
              toolCallBuffer[toolCallIndex] = "";
            }

            toolCallBuffer[toolCallIndex] += text;
          } else {
            controller.enqueue({
              type: "text-delta",
              id: generateId(),
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

        // publish text before the tag
        publish(buffer.slice(0, startIndex));

        const foundFullMatch = startIndex + nextTag.length <= buffer.length;

        if (foundFullMatch) {
          buffer = buffer.slice(startIndex + nextTag.length);
          toolCallIndex++;
          isToolCall = !isToolCall;
          afterSwitch = true;
        } else {
          buffer = buffer.slice(startIndex);
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
