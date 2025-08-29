import type {
  LanguageModelV2,
  LanguageModelV2Content,
  LanguageModelV2FunctionTool,
  LanguageModelV2ToolCall,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";

import { ToolCallProtocol } from "./protocols/tool-call-protocol";
import {
  extractOnErrorOption,
  getFunctionTools,
  isToolChoiceActive,
} from "./utils";
import { coerceToolCallInput } from "./utils/coercion";
import {
  getDebugLevel,
  logParsedChunk,
  logParsedSummary,
  logRawChunk,
} from "./utils/debug";

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
      const debugLevel = getDebugLevel();
      if (debugLevel === "parse") {
        logRawChunk(first.text);
      }
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
      // Defer summary logging until toolCall object is constructed below
    }

    const toolCall: LanguageModelV2ToolCall = {
      type: "tool-call",
      toolCallId: generateId(),
      toolName: parsed.name || "unknown",
      input: JSON.stringify(parsed.arguments || {}),
    };

    // Use the same parse-summary shape as streaming path
    const debugLevelToolChoice = getDebugLevel();
    const originText = first && first.type === "text" ? first.text : "";
    if (debugLevelToolChoice === "parse") {
      logParsedSummary({ toolCalls: [toolCall], originalText: originText });
    }

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
    const debugLevel = getDebugLevel();
    if (debugLevel === "stream") {
      // For generate flow with stream debug we show raw text and parsed parts
      logRawChunk(contentItem.text);
    }
    return protocol.parseGeneratedText({
      text: contentItem.text,
      tools: getFunctionTools(params),
      options: {
        ...extractOnErrorOption(params.providerOptions),
        ...((
          params.providerOptions as { toolCallMiddleware?: unknown } | undefined
        )?.toolCallMiddleware as Record<string, unknown>),
      },
    });
  });
  const tools = getFunctionTools(params);
  const newContent = parsed.map(part =>
    coerceToolCallInput(part as LanguageModelV2Content, tools)
  );

  const debugLevel = getDebugLevel();
  if (debugLevel === "stream") {
    newContent.forEach(part => logParsedChunk(part));
  }
  if (debugLevel === "parse") {
    const allText = result.content
      .filter(
        (c): c is Extract<LanguageModelV2Content, { type: "text" }> =>
          c.type === "text"
      )
      .map(c => c.text)
      .join("\n\n");
    const segments = protocol.extractToolCallSegments
      ? protocol.extractToolCallSegments({ text: allText, tools })
      : [];
    const originalText = segments.join("\n\n");
    const toolCalls = newContent.filter(
      (p): p is Extract<LanguageModelV2Content, { type: "tool-call" }> =>
        (p as LanguageModelV2Content).type === "tool-call"
    );
    logParsedSummary({ toolCalls, originalText });
  }

  return {
    ...result,
    content: newContent,
  };
}
