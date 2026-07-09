import type {
  LanguageModelV4FilePart,
  LanguageModelV4TextPart,
} from "@ai-sdk/provider";

export type ToolResponseUserContentPart =
  | LanguageModelV4TextPart
  | LanguageModelV4FilePart;

export type ToolResponsePromptTemplateResult =
  | string
  | ToolResponseUserContentPart[];
