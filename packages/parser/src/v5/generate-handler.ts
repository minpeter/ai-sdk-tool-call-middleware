import { coerceBySchema } from "@ai-sdk-tool/rxml";
import type { ToolCallProtocol } from "../core/protocols/tool-call-protocol";
import {
  getDebugLevel,
  logParsedChunk,
  logParsedSummary,
  logRawChunk,
} from "../core/utils/debug";
import { extractOnErrorOption } from "../core/utils/on-error";
import { originalToolsSchema } from "../core/utils/provider-options";

// biome-ignore lint/suspicious/noExplicitAny: AI SDK v5 content items have different shape than internal types
type V5ContentItem = any;

function parseContent(
  content: V5ContentItem[],
  protocol: ToolCallProtocol,
  // biome-ignore lint/suspicious/noExplicitAny: AI SDK v5 tool schema compatibility
  tools: any[],
  // biome-ignore lint/suspicious/noExplicitAny: AI SDK v5 provider options
  providerOptions?: any
): V5ContentItem[] {
  const debugLevel = getDebugLevel();

  const parsed = content.flatMap((contentItem: V5ContentItem) => {
    if (contentItem.type !== "text") {
      return [contentItem];
    }
    if (debugLevel === "stream") {
      logRawChunk(contentItem.text);
    }
    return protocol.parseGeneratedText({
      text: contentItem.text,
      tools,
      options: {
        ...extractOnErrorOption(providerOptions),
        ...(providerOptions?.toolCallMiddleware || {}),
      },
    });
  });

  return parsed.map((part: V5ContentItem) => {
    if (part.type !== "tool-call") {
      return part;
    }
    const tc = part as { toolName: string; input: unknown };
    let args: Record<string, unknown> = {};
    if (typeof tc.input === "string") {
      try {
        args = JSON.parse(tc.input) as Record<string, unknown>;
      } catch {
        return part;
      }
    } else {
      args = (tc.input ?? {}) as Record<string, unknown>;
    }
    const schema = tools.find(
      (t: { name: string }) => t.name === tc.toolName
    )?.inputSchema;
    const coerced = coerceBySchema(args, schema);
    return {
      ...part,
      input: coerced ?? {},
    };
  });
}

function logParsedContent(content: V5ContentItem[]) {
  if (getDebugLevel() === "stream") {
    for (const part of content) {
      logParsedChunk(part);
    }
  }
}

function computeDebugSummary(options: {
  result: { content: V5ContentItem[] };
  newContent: V5ContentItem[];
  protocol: ToolCallProtocol;
  // biome-ignore lint/suspicious/noExplicitAny: AI SDK v5 tool schema compatibility
  tools: any[];
  // biome-ignore lint/suspicious/noExplicitAny: AI SDK v5 provider options
  providerOptions?: any;
}) {
  const { result, newContent, protocol, tools, providerOptions } = options;
  const allText = result.content
    .filter((c: V5ContentItem) => c.type === "text")
    .map((c: V5ContentItem) => c.text)
    .join("\n\n");

  const segments = protocol.extractToolCallSegments
    ? protocol.extractToolCallSegments({ text: allText, tools })
    : [];
  const originalText = segments.join("\n\n");

  const toolCalls = newContent.filter(
    (p: V5ContentItem) => p.type === "tool-call"
  );

  const dbg = providerOptions?.toolCallMiddleware?.debugSummary;
  if (dbg) {
    dbg.originalText = originalText;
    try {
      dbg.toolCalls = JSON.stringify(
        toolCalls.map((tc: V5ContentItem) => ({
          toolName: tc.toolName,
          input: tc.input,
        }))
      );
    } catch {
      // ignore JSON failure
    }
  } else if (getDebugLevel() === "parse") {
    logParsedSummary({ toolCalls, originalText });
  }
}

export async function wrapGenerateV5({
  protocol,
  doGenerate,
  params,
}: {
  protocol: ToolCallProtocol;
  // biome-ignore lint/suspicious/noExplicitAny: AI SDK v5 generate result
  doGenerate: () => Promise<any>;
  // biome-ignore lint/suspicious/noExplicitAny: AI SDK v5 params structure
  params: any;
}) {
  const tools = originalToolsSchema.decode(
    params.providerOptions?.toolCallMiddleware?.originalTools
  );

  const result = await doGenerate();

  if (!result.content || result.content.length === 0) {
    return result;
  }

  const newContent = parseContent(
    result.content,
    protocol,
    tools,
    params.providerOptions
  );

  logParsedContent(newContent);
  computeDebugSummary({
    result,
    newContent,
    protocol,
    tools,
    providerOptions: params.providerOptions,
  });

  return {
    ...result,
    content: newContent,
  };
}
