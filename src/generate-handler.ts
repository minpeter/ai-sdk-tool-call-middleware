import type {
  LanguageModelV4,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4ToolCall,
  SharedV4Warning,
} from "@ai-sdk/provider";
import type { TCMCoreProtocol } from "./core/protocols/protocol-interface";
import {
  getDebugLevel,
  logParsedChunk,
  logParsedSummary,
  logRawChunk,
} from "./core/utils/debug";
import {
  normalizeForcedToolChoiceFinishReason,
  normalizeToolCallsFinishReason,
  shouldRewriteFinishReasonToToolCalls,
} from "./core/utils/finish-reason";
import { recoverToolCallFromJsonCandidatesWithStatus } from "./core/utils/generated-text-json-recovery";
import { generateToolCallId } from "./core/utils/id";
import { extractOnErrorOption } from "./core/utils/on-error";
import {
  decodeOriginalToolsFromProviderOptions,
  getDroppedProviderTools,
  getToolCallMiddlewareOptions,
  isToolChoiceActive,
  isToolChoiceNone,
  type ToolCallMiddlewareProviderOptions,
} from "./core/utils/provider-options";
import { coerceToolCallPart } from "./core/utils/tool-call-coercion";
import {
  findToolChoiceTextContent,
  resolveToolChoiceSelection,
} from "./core/utils/tool-choice";

function logDebugSummary(
  debugSummary: { originalText?: string; toolCalls?: string } | undefined,
  toolCall: LanguageModelV4ToolCall,
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

/**
 * Prompt-based tool calling can only express function tools; provider tools
 * are dropped in transformParams and surfaced here as spec warnings.
 */
function appendDroppedProviderToolWarnings(
  warnings: SharedV4Warning[] | undefined,
  providerOptions: unknown
): SharedV4Warning[] {
  const dropped = getDroppedProviderTools(providerOptions);
  if (dropped.length === 0) {
    return warnings ?? [];
  }
  return [
    ...(warnings ?? []),
    ...dropped.map(
      (name): SharedV4Warning => ({
        type: "unsupported",
        feature: `provider tool ${name}`,
        details:
          "Prompt-based tool-call middleware only supports function tools; the provider tool was removed from the request.",
      })
    ),
  ];
}

async function handleToolChoice(
  doGenerate: () => ReturnType<LanguageModelV4["doGenerate"]>,
  params: { providerOptions?: ToolCallMiddlewareProviderOptions },
  tools: LanguageModelV4FunctionTool[]
) {
  const result = await doGenerate();
  const firstText = findToolChoiceTextContent(result.content);
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

  const toolCall: LanguageModelV4ToolCall = {
    type: "tool-call",
    toolCallId: generateToolCallId(),
    toolName,
    input,
  };

  const debugSummary = params.providerOptions?.toolCallMiddleware?.debugSummary;
  logDebugSummary(debugSummary, toolCall, originText);

  // Text content is consumed by the forced tool call; every other part
  // (reasoning, files, sources) is model output the caller may still need.
  const nonTextContent = (result.content ?? []).filter(
    (part) => part.type !== "text"
  );

  return {
    ...result,
    content: [...nonTextContent, toolCall],
    warnings: appendDroppedProviderToolWarnings(
      result.warnings,
      params.providerOptions
    ),
    finishReason: normalizeForcedToolChoiceFinishReason(result.finishReason),
  };
}

function parseContent(
  content: LanguageModelV4Content[],
  protocol: TCMCoreProtocol,
  tools: LanguageModelV4FunctionTool[],
  providerOptions?: ToolCallMiddlewareProviderOptions
): LanguageModelV4Content[] {
  const parsed = content.flatMap((contentItem): LanguageModelV4Content[] => {
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
      (part): part is Extract<LanguageModelV4Content, { type: "tool-call" }> =>
        part.type === "tool-call"
    );
    if (hasToolCall) {
      return parsedByProtocol;
    }

    const recoveredFromJson = recoverToolCallFromJsonCandidatesWithStatus(
      contentItem.text,
      tools
    );
    if (recoveredFromJson.kind === "recovered") {
      return recoveredFromJson.content;
    }
    if (recoveredFromJson.kind === "dropped-sensitive-candidate") {
      return [];
    }
    return parsedByProtocol;
  });

  // Provider-executed tool calls belong to the provider's own tools; their
  // inputs must pass through byte-identical rather than be re-coerced against
  // the client tool schemas.
  return parsed.map((part) =>
    part.type === "tool-call" && !part.providerExecuted
      ? coerceToolCallPart(part, tools)
      : part
  );
}

function logParsedContent(content: LanguageModelV4Content[]) {
  if (getDebugLevel() === "stream") {
    for (const part of content) {
      logParsedChunk(part);
    }
  }
}

function computeDebugSummary(options: {
  result: { content: LanguageModelV4Content[] };
  newContent: LanguageModelV4Content[];
  protocol: TCMCoreProtocol;
  tools: LanguageModelV4FunctionTool[];
  providerOptions?: ToolCallMiddlewareProviderOptions;
}) {
  const { result, newContent, protocol, tools, providerOptions } = options;
  const allText = result.content
    .filter(
      (c): c is Extract<LanguageModelV4Content, { type: "text" }> =>
        c.type === "text"
    )
    .map((c) => c.text)
    .join("\n\n");

  const segments = protocol.extractToolCallSegments
    ? protocol.extractToolCallSegments({ text: allText, tools })
    : [];
  const originalText = segments.join("\n\n");

  const toolCalls = newContent.filter(
    (p): p is Extract<LanguageModelV4Content, { type: "tool-call" }> =>
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
  doGenerate: () => ReturnType<LanguageModelV4["doGenerate"]>;
  params: {
    providerOptions?: ToolCallMiddlewareProviderOptions;
  };
}) {
  if (isToolChoiceNone(params)) {
    // toolChoice 'none': no tool prompt was injected and no tool calls are
    // expected, so return the model result untouched.
    return doGenerate();
  }

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
    return {
      ...result,
      warnings: appendDroppedProviderToolWarnings(
        result.warnings,
        params.providerOptions
      ),
    };
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

  // Only client-executed tool calls signal that the SDK should run a tool;
  // provider-executed calls already finished on the provider side.
  const hasParsedToolCall = newContent.some(
    (part) => part.type === "tool-call" && !part.providerExecuted
  );

  return {
    ...result,
    content: newContent,
    warnings: appendDroppedProviderToolWarnings(
      result.warnings,
      params.providerOptions
    ),
    finishReason:
      hasParsedToolCall &&
      shouldRewriteFinishReasonToToolCalls(result.finishReason)
        ? normalizeToolCallsFinishReason(result.finishReason)
        : result.finishReason,
  };
}
