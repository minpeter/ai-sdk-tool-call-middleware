import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3Middleware,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";

type SystemPromptPlacement = "first" | "last";

interface DefaultSystemPromptMiddlewareOptions {
  systemPrompt: string;
  placement?: SystemPromptPlacement;
}

function extractSystemText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    if (content == null) {
      return;
    }
    return String(content);
  }

  const parts = (content as LanguageModelV3Content[]).map((part) => {
    if (part?.type === "text" && "text" in part) {
      return String(part.text ?? "");
    }

    return JSON.stringify(part);
  });

  const textParts = parts.filter((value) => value.length > 0);
  if (textParts.length === 0) {
    return;
  }

  return textParts.join("\n");
}

function mergeSystemPrompts({
  base,
  addition,
  placement,
}: {
  base?: string;
  addition: string;
  placement: SystemPromptPlacement;
}): string {
  if (!base) {
    return addition;
  }

  if (addition.length === 0) {
    return base;
  }

  return placement === "first"
    ? `${addition}\n\n${base}`
    : `${base}\n\n${addition}`;
}

function ensurePromptArray(
  prompt?: LanguageModelV3Prompt
): LanguageModelV3Prompt {
  if (!prompt) {
    return [];
  }

  return [...prompt];
}

export function defaultSystemPromptMiddleware({
  systemPrompt,
  placement = "first",
}: DefaultSystemPromptMiddlewareOptions): LanguageModelV3Middleware {
  return {
    specificationVersion: "v3",
    transformParams: ({ params }) => {
      const prompt = ensurePromptArray(params.prompt);
      const systemIndex = prompt.findIndex(
        (message) => message.role === "system"
      );

      if (systemIndex === -1) {
        const promptWithSystem =
          placement === "first"
            ? ([
                {
                  role: "system" as const,
                  content: systemPrompt,
                },
                ...prompt,
              ] as LanguageModelV3Prompt)
            : ([
                ...prompt,
                {
                  role: "system" as const,
                  content: systemPrompt,
                },
              ] as LanguageModelV3Prompt);

        const nextParams: LanguageModelV3CallOptions = {
          ...params,
          prompt: promptWithSystem,
        };

        return Promise.resolve<LanguageModelV3CallOptions>(nextParams);
      }

      const systemMessage = prompt[systemIndex];
      const baseText = extractSystemText(systemMessage.content);
      const mergedContent = mergeSystemPrompts({
        base: baseText,
        addition: systemPrompt,
        placement,
      });

      const updatedPrompt = prompt.map((message, index) =>
        index === systemIndex
          ? {
              ...message,
              content: mergedContent,
            }
          : message
      ) as LanguageModelV3Prompt;

      const nextParams: LanguageModelV3CallOptions = {
        ...params,
        prompt: updatedPrompt,
      };

      return Promise.resolve<LanguageModelV3CallOptions>(nextParams);
    },
  };
}
