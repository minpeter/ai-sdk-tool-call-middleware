import type {
  LanguageModelV2,
  LanguageModelV2Content,
  LanguageModelV2ToolCall,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import * as RXML from "@ai-sdk-tool/rxml";

import { ToolCallProtocol } from "./protocols/tool-call-protocol";
import {
  extractOnErrorOption,
  isToolChoiceActive,
  originalToolsSchema,
  ToolCallMiddlewareProviderOptions,
} from "./utils";
import {
  getDebugLevel,
  logParsedChunk,
  logParsedSummary,
  logRawChunk,
} from "./utils/debug";

export async function wrapGenerate({
  protocol,
  doGenerate,
  params,
}: {
  protocol: ToolCallProtocol;
  doGenerate: () => ReturnType<LanguageModelV2["doGenerate"]>;
  params: {
    providerOptions?: ToolCallMiddlewareProviderOptions;
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

    // Use the same parse-summary shape as streaming path, preferring debugSummary
    const debugLevelToolChoice = getDebugLevel();
    const originText = first && first.type === "text" ? first.text : "";
    const dbg = params.providerOptions?.toolCallMiddleware?.debugSummary;
    if (dbg) {
      dbg.originalText = originText;
      try {
        dbg.toolCalls = JSON.stringify([
          { toolName: toolCall.toolName, input: toolCall.input },
        ]);
      } catch {
        // ignore
      }
    } else if (debugLevelToolChoice === "parse") {
      logParsedSummary({ toolCalls: [toolCall], originalText: originText });
    }

    return {
      ...result,
      content: [toolCall],
    };
  }

  const tools = originalToolsSchema.decode(
    params.providerOptions?.toolCallMiddleware?.originalTools
  );

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
      tools: tools,
      options: {
        ...extractOnErrorOption(params.providerOptions),
        ...((
          params.providerOptions as { toolCallMiddleware?: unknown } | undefined
        )?.toolCallMiddleware as Record<string, unknown>),
      },
    });
  });
  const newContent = parsed.map(part =>
    fixToolCallWithSchema(part as LanguageModelV2Content, tools)
  );

  const debugLevel = getDebugLevel();
  if (debugLevel === "stream") {
    newContent.forEach(part => logParsedChunk(part));
  }
  // Always compute a debug summary payload; only log to console if no container provided and parse-level
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

  const dbg = params.providerOptions?.toolCallMiddleware?.debugSummary;
  if (dbg) {
    dbg.originalText = originalText;
    try {
      dbg.toolCalls = JSON.stringify(
        toolCalls.map(tc => ({
          toolName: tc.toolName,
          input: tc.input as unknown,
        }))
      );
    } catch {
      // ignore JSON failure
    }
  } else if (debugLevel === "parse") {
    logParsedSummary({ toolCalls, originalText });
  }

  return {
    ...result,
    content: newContent,
  };
}

function fixToolCallWithSchema(
  part: LanguageModelV2Content,
  tools: Array<{ name?: string; inputSchema?: unknown }>
): LanguageModelV2Content {
  if ((part as { type?: string }).type !== "tool-call") return part;
  const tc = part as unknown as { toolName: string; input: unknown };
  let args: unknown = {};
  if (typeof tc.input === "string") {
    try {
      args = JSON.parse(tc.input);
    } catch {
      return part;
    }
  } else if (tc.input && typeof tc.input === "object") {
    args = tc.input;
  }
  const schema = tools.find(t => t.name === tc.toolName)
    ?.inputSchema as unknown;
  const coerced = RXML.coerceBySchema(args, schema);
  return {
    ...(part as Record<string, unknown>),
    input: JSON.stringify(coerced ?? {}),
  } as LanguageModelV2Content;
}
