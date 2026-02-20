import type { LanguageModelV3TextPart } from "@ai-sdk/provider";

export function toTextPart(
  text: string,
  providerOptions?: LanguageModelV3TextPart["providerOptions"]
): LanguageModelV3TextPart {
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
