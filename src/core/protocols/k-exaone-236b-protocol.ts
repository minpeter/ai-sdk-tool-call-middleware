import type { LanguageModelV4ToolCall } from "@ai-sdk/provider";
import { stringifyKExaone2NativeJson } from "../prompts/k-exaone-2-native-json";
import { hermesProtocol } from "./hermes-protocol";
import { parseKExaoneToolCallInput } from "./k-exaone-tool-call-input";
import type { TCMProtocol } from "./protocol-interface";

function formatKExaone236BToolCall(toolCall: LanguageModelV4ToolCall): string {
  return `<tool_call>${stringifyKExaone2NativeJson({
    name: toolCall.toolName,
    arguments: parseKExaoneToolCallInput(toolCall.input),
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
