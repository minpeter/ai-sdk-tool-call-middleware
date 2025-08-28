import type {
  LanguageModelV2,
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2ToolCall,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import { ToolCallProtocol } from "./protocols/tool-call-protocol";
import { coerceToolCallInput } from "./utils/coercion";
import {
  isToolChoiceActive,
  getFunctionTools,
  extractOnErrorOption,
} from "./utils";

type WrapGenerateParams = {
  prompt?: unknown;
  tools?: Array<LanguageModelV2FunctionTool | { type: string }>;
  providerOptions?: unknown;
};

export async function wrapGenerate({
  protocol,
  doGenerate,
  params,
}: {
  protocol: ToolCallProtocol;
  doGenerate: () => ReturnType<LanguageModelV2["doGenerate"]>;
  params: WrapGenerateParams & {
    providerOptions?: {
      toolCallMiddleware?: {
        toolChoice?: { type: string };
      };
    };
  };
}) {
  if (isToolChoiceActive(params)) {
    const result = await doGenerate();
    let parsed: { name?: string; arguments?: Record<string, unknown> } = {};
    const first = result.content?.[0];
    if (first && first.type === "text") {
      try {
        parsed = JSON.parse(first.text);
      } catch (error) {
        const options = extractOnErrorOption(params.providerOptions);
        options?.onError?.(
          "Failed to parse toolChoice JSON from generated model output",
          {
            text: first.text,
            error: error instanceof Error ? error.message : String(error),
          }
        );
        parsed = {};
      }
    }

    const toolCall: LanguageModelV2ToolCall = {
      type: "tool-call",
      toolCallId: generateId(),
      toolName: parsed.name || "unknown",
      input: JSON.stringify(parsed.arguments || {}),
    };

    return {
      ...result,
      content: [toolCall],
    };
  }

  const result = await doGenerate();

  if (result.content.length === 0) {
    return result;
  }

  const parsed = result.content.flatMap(contentItem => {
    if (contentItem.type !== "text") {
      return [contentItem];
    }
    return protocol.parseGeneratedText({
      text: contentItem.text,
      tools: getFunctionTools(params),
      options: {
        ...extractOnErrorOption(params.providerOptions),
        ...(params.providerOptions as any)?.toolCallMiddleware,
      },
    });
  });
  const tools = getFunctionTools(params);
  const newContent = parsed.map(part =>
    coerceToolCallInput(part as LanguageModelV2Content, tools)
  );

  return {
    ...result,
    content: newContent,
  };
}
