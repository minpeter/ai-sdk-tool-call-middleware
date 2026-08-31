import type {
  LanguageModelV4FunctionTool,
  LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { generateToolCallId } from "../utils/id";
import { enqueueToolInputEndAndCall } from "../utils/tool-input-streaming";
import { parseGlm5AnchoredBareToolCall } from "./glm5-bare-tool-call";
import { potentialGlm5OpenSuffixIndex } from "./glm5-stream-close-scanner";

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;

interface Glm5TextBufferOptions {
  flushText: (controller: StreamController, text?: string) => void;
  tools: LanguageModelV4FunctionTool[];
}

export type FlushSafeGlm5TextBuffer = (
  controller: StreamController,
  textBuffer: string
) => string;

export function createFlushSafeGlm5TextBuffer({
  flushText,
  tools,
}: Glm5TextBufferOptions): FlushSafeGlm5TextBuffer {
  return (controller, textBuffer) => {
    const potentialIndex = potentialGlm5OpenSuffixIndex(textBuffer);
    if (potentialIndex === null) {
      const bareCall = parseGlm5AnchoredBareToolCall({
        text: textBuffer,
        tools,
      });
      if (bareCall) {
        const id = generateToolCallId();
        flushText(controller);
        controller.enqueue({
          type: "tool-input-start",
          id,
          toolName: bareCall.toolName,
        });
        enqueueToolInputEndAndCall({
          controller,
          id,
          input: bareCall.input,
          toolName: bareCall.toolName,
        });
      } else {
        const trimmed = textBuffer.trimStart();
        if (
          tools.some(
            (tool) =>
              tool.name.startsWith(trimmed) ||
              trimmed.startsWith(`${tool.name}(`)
          ) &&
          !trimmed.includes("\n")
        ) {
          return textBuffer;
        }
        flushText(controller, textBuffer);
      }
      return "";
    }
    if (potentialIndex > 0) {
      flushText(controller, textBuffer.slice(0, potentialIndex));
      return textBuffer.slice(potentialIndex);
    }
    return textBuffer;
  };
}
