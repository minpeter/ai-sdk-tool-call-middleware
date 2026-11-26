import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { kExaone236BSystemPromptMessages } from "./core/prompts/k-exaone-236b-prompt";
import { kExaone236BProtocol } from "./core/protocols/k-exaone-236b-protocol";
import { transformParams } from "./transform-handler";

const kExaone236BProtocolInstance = kExaone236BProtocol();

export function transformKExaone236BParams(
  params: LanguageModelV4CallOptions
): LanguageModelV4CallOptions {
  return transformParams({
    params,
    protocol: kExaone236BProtocolInstance,
    toolSystemPromptTemplate: () => "",
    toolSystemPromptMessages: kExaone236BSystemPromptMessages,
    historyMode: "provider-native",
  });
}
