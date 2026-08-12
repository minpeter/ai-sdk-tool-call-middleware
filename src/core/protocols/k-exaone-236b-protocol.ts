import type { LanguageModelV4ToolCall } from "@ai-sdk/provider";
import { parseKExaone2LosslessJson } from "../prompts/k-exaone-2-lossless-json";
import { stringifyKExaone2NativeJson } from "../prompts/k-exaone-2-native-json";
import { KExaone2SerializationError } from "../prompts/k-exaone-2-serialization-error";
import { hermesProtocol } from "./hermes-protocol";
import type { TCMProtocol } from "./protocol-interface";

function parseToolCallInput(input: string | null | undefined): unknown {
  if (input == null) {
    return {};
  }

  try {
    return parseKExaone2LosslessJson(input);
  } catch (error) {
    if (error instanceof KExaone2SerializationError) {
      throw error;
    }
    return input;
  }
}

function formatKExaone236BToolCall(toolCall: LanguageModelV4ToolCall): string {
  return `<tool_call>${stringifyKExaone2NativeJson({
    name: toolCall.toolName,
    arguments: parseToolCallInput(toolCall.input),
  })}</tool_call>`;
}

export const kExaone236BProtocol = (): TCMProtocol => {
  const protocol = hermesProtocol();

  return {
    ...protocol,
    formatToolCall: formatKExaone236BToolCall,
  };
};

export const KExaone236BToolParser = kExaone236BProtocol;
