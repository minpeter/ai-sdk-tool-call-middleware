import type {
  LanguageModelV3,
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3ToolCall,
} from "@ai-sdk/provider";
import type { TCMCoreProtocol } from "./core/protocols/protocol-interface";
import {
  getDebugLevel,
  logParsedChunk,
  logParsedSummary,
  logRawChunk,
} from "./core/utils/debug";
import { recoverToolCallFromJsonCandidates } from "./core/utils/generated-text-json-recovery";
import { generateToolCallId } from "./core/utils/id";
import { extractOnErrorOption } from "./core/utils/on-error";
import {
  decodeOriginalToolsFromProviderOptions,
  getToolCallMiddlewareOptions,
  isToolChoiceActive,
  type ToolCallMiddlewareProviderOptions,
} from "./core/utils/provider-options";
import { coerceToolCallPart } from "./core/utils/tool-call-coercion";
import { resolveToolChoiceSelection } from "./core/utils/tool-choice";

function logDebugSummary(
  debugSummary: { originalText?: string; toolCalls?: string } | undefined,
  toolCall: LanguageModelV3ToolCall,
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
  doGenerate: () => ReturnType<LanguageModelV3["doGenerate"]>,
  params: { providerOptions?: ToolCallMiddlewareProviderOptions },
  tools: LanguageModelV3FunctionTool[]
) {
  const result = await doGenerate();
  const first = result.content?.[0];
  const firstText = first?.type === "text" ? first.text : undefined;
  const onError = extractOnErrorOption(params.providerOptions)?.onError;

  if (typeof firstText === "string" && getDebugLevel() === "parse") {
    logRawChunk(firstText);
  }

  const { toolName, input, originText } = resolveToolChoiceSelection({
    text: firstText,
    tools,
    onError,
    errorMessage: "Failed to parse toolChoice JSON from generated model output",
  });

  const toolCall: LanguageModelV3ToolCall = {
    type: "tool-call",
    toolCallId: generateToolCallId(),
    toolName,
    input,
  };

  const debugSummary = params.providerOptions?.toolCallMiddleware?.debugSummary;
  logDebugSummary(debugSummary, toolCall, originText);

  return {
    ...result,
    content: [toolCall],
  };
}

function parseContent(
  content: LanguageModelV3Content[],
  protocol: TCMCoreProtocol,
  tools: LanguageModelV3FunctionTool[],
  providerOptions?: ToolCallMiddlewareProviderOptions
): LanguageModelV3Content[] {
  const parsed = content.flatMap((contentItem): LanguageModelV3Content[] => {
    if (contentItem.type !== "text") {
      return [contentItem];
    }
    if (getDebugLevel() === "stream") {
      logRawChunk(contentItem.text);
    }
    const parsedByProtocol = protocol.parseGeneratedText({
      text: contentItem.text,
      tools,
      options: {
        ...extractOnErrorOption(providerOptions),
        ...getToolCallMiddlewareOptions(providerOptions),
      },
    });

    const hasToolCall = parsedByProtocol.some(
      (part): part is Extract<LanguageModelV3Content, { type: "tool-call" }> =>
        part.type === "tool-call"
    );
    if (hasToolCall) {
      return parsedByProtocol;
    }

    const recoveredFromJson = recoverToolCallFromJsonCandidates(
      contentItem.text,
      tools
    );
    return recoveredFromJson ?? parsedByProtocol;
  });

  return parsed.map((part) =>
    part.type === "tool-call" ? coerceToolCallPart(part, tools) : part
  );
}

function logParsedContent(content: LanguageModelV3Content[]) {
  if (getDebugLevel() === "stream") {
    for (const part of content) {
      logParsedChunk(part);
    }
  }
}

function computeDebugSummary(options: {
  result: { content: LanguageModelV3Content[] };
  newContent: LanguageModelV3Content[];
  protocol: TCMCoreProtocol;
  tools: LanguageModelV3FunctionTool[];
  providerOptions?: ToolCallMiddlewareProviderOptions;
}) {
  const { result, newContent, protocol, tools, providerOptions } = options;
  const allText = result.content
    .filter(
      (c): c is Extract<LanguageModelV3Content, { type: "text" }> =>
        c.type === "text"
    )
    .map((c) => c.text)
    .join("\n\n");

  const segments = protocol.extractToolCallSegments
    ? protocol.extractToolCallSegments({ text: allText, tools })
    : [];
  const originalText = segments.join("\n\n");

  const toolCalls = newContent.filter(
    (p): p is Extract<LanguageModelV3Content, { type: "tool-call" }> =>
      p.type === "tool-call"
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
  protocol: TCMCoreProtocol;
  doGenerate: () => ReturnType<LanguageModelV3["doGenerate"]>;
  params: {
    providerOptions?: ToolCallMiddlewareProviderOptions;
  };
}) {
  const onError = extractOnErrorOption(params.providerOptions);
  const tools = decodeOriginalToolsFromProviderOptions(
    params.providerOptions,
    onError
  );

  if (isToolChoiceActive(params)) {
    return handleToolChoice(doGenerate, params, tools);
  }

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
