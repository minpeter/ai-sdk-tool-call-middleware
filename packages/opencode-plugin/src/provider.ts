import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { morphXmlToolMiddleware } from "@ai-sdk-tool/parser/v5";
import { type LanguageModel, wrapLanguageModel } from "ai";

export interface FriendliGlmXmlProviderOptions {
  apiKey?: string;
  baseURL?: string;
  name?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export function createFriendliGlmXml(
  options: FriendliGlmXmlProviderOptions = {}
) {
  const baseProvider = createOpenAICompatible({
    name: options.name ?? "friendli-glm-xml",
    apiKey: options.apiKey,
    baseURL: options.baseURL ?? "https://api.friendli.ai/serverless/v1",
    headers: options.headers,
    fetch: options.fetch,
  });

  return {
    languageModel(modelId: string): LanguageModel {
      const baseModel = baseProvider.languageModel(modelId);
      return wrapLanguageModel({
        model: baseModel,
        middleware: morphXmlToolMiddleware as unknown as Parameters<
          typeof wrapLanguageModel
        >[0]["middleware"],
      });
    },

    chat(modelId: string): LanguageModel {
      return this.languageModel(modelId);
    },
  };
}

export default createFriendliGlmXml;
