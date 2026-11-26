import type { LanguageModelV4TextPart } from "@ai-sdk/provider";

export function toTextPart(
  text: string,
  providerOptions?: LanguageModelV4TextPart["providerOptions"]
): LanguageModelV4TextPart {
  if (providerOptions === undefined) {
    return {
      type: "text",
      text,
    };
  }

  return {
    type: "text",
    text,
    providerOptions,
  };
}
