import type {
  LanguageModelV2,
  LanguageModelV2Content,
  LanguageModelV2ToolCall,
} from "@ai-sdk/provider";
import { generateId } from "@ai-sdk/provider-utils";
import { coerceBySchema } from "@ai-sdk-tool/rxml";

import type { ToolCallProtocol } from "./protocols/tool-call-protocol";
import {
  extractOnErrorOption,
  isToolChoiceActive,
  originalToolsSchema,
  type ToolCallMiddlewareProviderOptions,
} from "./utils";
import {
  getDebugLevel,
  logParsedChunk,
  logParsedSummary,
  logRawChunk,
} from "./utils/debug";

function parseToolChoiceJson(
  text: string,
  providerOptions?: ToolCallMiddlewareProviderOptions
): { name?: string; arguments?: Record<string, unknown> } {
  try {
    return JSON.parse(text);
  } catch (error) {
    const options = extractOnErrorOption(providerOptions);
    options?.onError?.(
      "Failed to parse toolChoice JSON from generated model output",
      {
        text,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return {};
  }
}

function logDebugSummary(
  debugSummary: { originalText?: string; toolCalls?: string } | undefined,
  toolCall: LanguageModelV2ToolCall,
  originText: string
) {
  if (debugSummary) {
    debugSummary.originalText = originText;
    try {
      debugSummary.toolCalls = JSON.stringify([
        { toolName: toolCall.toolName, input: toolCall.input },
      ]);
    } catch {
      // ignore
    }
  } else if (getDebugLevel() === "parse") {
    logParsedSummary({ toolCalls: [toolCall], originalText: originText });
  }
}

async function handleToolChoice(
  doGenerate: () => ReturnType<LanguageModelV2["doGenerate"]>,
  params: { providerOptions?: ToolCallMiddlewareProviderOptions }
) {
  const result = await doGenerate();
  const first = result.content?.[0];

  let parsed: { name?: string; arguments?: Record<string, unknown> } = {};
  if (first && first.type === "text") {
    if (getDebugLevel() === "parse") {
      logRawChunk(first.text);
    }
    parsed = parseToolChoiceJson(first.text, params.providerOptions);
  }

  const toolCall: LanguageModelV2ToolCall = {
    type: "tool-call",
    toolCallId: generateId(),
    toolName: parsed.name || "unknown",
    input: JSON.stringify(parsed.arguments || {}),
  };

  const originText = first && first.type === "text" ? first.text : "";
  const debugSummary = params.providerOptions?.toolCallMiddleware?.debugSummary;
  logDebugSummary(debugSummary, toolCall, originText);

  return {
    ...result,
    content: [toolCall],
  };
}

function parseContent(
  content: LanguageModelV2Content[],
  protocol: ToolCallProtocol,
  tools: Array<{ name?: string; inputSchema?: unknown }>,
  providerOptions?: ToolCallMiddlewareProviderOptions
): LanguageModelV2Content[] {
  const parsed = content.flatMap((contentItem) => {
    if (contentItem.type !== "text") {
      return [contentItem];
    }
    if (getDebugLevel() === "stream") {
      logRawChunk(contentItem.text);
    }
    return protocol.parseGeneratedText({
      text: contentItem.text,
      tools,
      options: {
        ...extractOnErrorOption(providerOptions),
        ...((providerOptions as { toolCallMiddleware?: unknown } | undefined)
          ?.toolCallMiddleware as Record<string, unknown>),
      },
    });
  });

  return parsed.map((part) =>
    fixToolCallWithSchema(part as LanguageModelV2Content, tools)
  );
}

function logParsedContent(content: LanguageModelV2Content[]) {
  if (getDebugLevel() === "stream") {
    for (const part of content) {
      logParsedChunk(part);
    }
  }
}

function computeDebugSummary(
  result: { content: LanguageModelV2Content[] },
  newContent: LanguageModelV2Content[],
  protocol: ToolCallProtocol,
  tools: Array<{ name?: string; inputSchema?: unknown }>,
  providerOptions?: ToolCallMiddlewareProviderOptions
) {
  const allText = result.content
    .filter(
      (c): c is Extract<LanguageModelV2Content, { type: "text" }> =>
        c.type === "text"
    )
    .map((c) => c.text)
    .join("\n\n");

  const segments = protocol.extractToolCallSegments
    ? protocol.extractToolCallSegments({ text: allText, tools })
    : [];
  const originalText = segments.join("\n\n");

  const toolCalls = newContent.filter(
    (p): p is Extract<LanguageModelV2Content, { type: "tool-call" }> =>
      (p as LanguageModelV2Content).type === "tool-call"
  );

  const dbg = providerOptions?.toolCallMiddleware?.debugSummary;
  if (dbg) {
    dbg.originalText = originalText;
    try {
      dbg.toolCalls = JSON.stringify(
        toolCalls.map((tc) => ({
          toolName: tc.toolName,
          input: tc.input as unknown,
        }))
      );
    } catch {
      // ignore JSON failure
    }
  } else if (getDebugLevel() === "parse") {
    logParsedSummary({ toolCalls, originalText });
  }
}

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
    return handleToolChoice(doGenerate, params);
  }

  const tools = originalToolsSchema.decode(
    params.providerOptions?.toolCallMiddleware?.originalTools
  );

  const result = await doGenerate();

  if (result.content.length === 0) {
    return result;
  }

  const newContent = parseContent(
    result.content,
    protocol,
    tools,
    params.providerOptions
  );

  logParsedContent(newContent);
  computeDebugSummary(
    result,
    newContent,
    protocol,
    tools,
    params.providerOptions
  );

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
  const schema = tools.find((t) => t.name === tc.toolName)
    ?.inputSchema as unknown;
  const coerced = coerceBySchema(args, schema);
  return {
    ...(part as Record<string, unknown>),
    input: JSON.stringify(coerced ?? {}),
  } as LanguageModelV2Content;
}
