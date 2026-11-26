import type {
  LanguageModelV4,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4ToolCall,
  SharedV4Warning,
} from "@ai-sdk/provider";
import type { TCMProtocol } from "./core/protocols/protocol-interface";
import { coerceToolCallPart } from "./core/utils/coercion/tool-call-coercion";
import {
  getDebugLevel,
  logParsedChunk,
  logRawChunk,
} from "./core/utils/diagnostics/debug";
import {
  recordForcedToolChoiceDebugSummary,
  recordParsedDebugSummary,
} from "./core/utils/diagnostics/debug-summary";
import { extractOnErrorOption } from "./core/utils/diagnostics/on-error";
import { generateToolCallId } from "./core/utils/primitives/id";
import { safeToolCallMetadataText } from "./core/utils/primitives/protocol-utils";
import { recoverToolCallFromJsonCandidatesWithStatus } from "./core/utils/recovery/generated-text-json-recovery";
import {
  normalizeForcedToolChoiceFinishReason,
  normalizeToolCallsFinishReason,
  shouldRewriteFinishReasonToToolCalls,
} from "./core/utils/response/finish-reason";
import { carryTextPartAnnotations } from "./core/utils/response/text-citations";
import {
  createDroppedProviderToolWarnings,
  decodeOriginalToolsForMiddleware,
  extractToolCallParserOptions,
  getToolChoiceExpectedToolName,
  isToolChoiceActive,
  isToolChoiceNone,
  type ToolCallMiddlewareProviderOptions,
} from "./core/utils/transport/provider-options";
import {
  findToolChoiceResultText,
  resolveToolChoiceSelection,
} from "./core/utils/transport/tool-choice";

function appendDroppedProviderToolWarnings(
  warnings: SharedV4Warning[] | undefined,
  providerOptions: unknown
): SharedV4Warning[] {
  const droppedWarnings = createDroppedProviderToolWarnings(providerOptions);
  if (droppedWarnings.length === 0) {
    return warnings ?? [];
  }
  return [...(warnings ?? []), ...droppedWarnings];
}

async function handleToolChoice(
  doGenerate: () => ReturnType<LanguageModelV4["doGenerate"]>,
  params: { providerOptions?: ToolCallMiddlewareProviderOptions },
  tools: LanguageModelV4FunctionTool[]
) {
  const result = await doGenerate();
  const firstText = findToolChoiceResultText(result);
  const onError = extractOnErrorOption(params.providerOptions)?.onError;

  if (typeof firstText === "string" && getDebugLevel() === "parse") {
    logRawChunk(safeToolCallMetadataText(firstText) ?? "");
  }

  const { toolName, input, originText } = resolveToolChoiceSelection({
    text: firstText,
    tools,
    onError,
    errorMessage: "Failed to parse toolChoice JSON from generated model output",
    expectedToolName: getToolChoiceExpectedToolName(params.providerOptions),
  });

  const toolCall: LanguageModelV4ToolCall = {
    type: "tool-call",
    toolCallId: generateToolCallId(),
    toolName,
    input,
  };

  recordForcedToolChoiceDebugSummary({
    debugSummary: params.providerOptions?.toolCallMiddleware?.debugSummary,
    originText,
    toolCall,
  });

  // Text content is consumed by the forced tool call; every other part
  // (reasoning, files, sources) is model output the caller may still need.
  const nonTextContent = (result.content ?? []).filter(
    (part) => part.type !== "text"
  );

  // `structuredOutputText` points at the text that just became the tool call;
  // leaving it would let the SDK parse the tool input as structured output.
  const { structuredOutputText: _consumedText, ...resultWithoutText } = result;

  return {
    ...resultWithoutText,
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
  protocol: TCMProtocol,
  tools: LanguageModelV4FunctionTool[],
  providerOptions?: ToolCallMiddlewareProviderOptions
): LanguageModelV4Content[] {
  const parsed: LanguageModelV4Content[] = [];

  for (const contentItem of content) {
    if (contentItem.type === "text") {
      const textParts = parseTextContent({
        contentItem,
        protocol,
        providerOptions,
        tools,
      });
      for (const part of carryTextPartAnnotations(contentItem, textParts)) {
        parsed.push(
          part.type === "tool-call" && !part.providerExecuted
            ? coerceToolCallPart(part, tools)
            : part
        );
      }
      continue;
    }

    parsed.push(
      contentItem.type === "tool-call" && !contentItem.providerExecuted
        ? coerceToolCallPart(contentItem, tools)
        : contentItem
    );
  }

  return parsed;
}

function parseTextContent(options: {
  contentItem: Extract<LanguageModelV4Content, { type: "text" }>;
  protocol: TCMProtocol;
  providerOptions?: ToolCallMiddlewareProviderOptions;
  tools: LanguageModelV4FunctionTool[];
}): LanguageModelV4Content[] {
  const { contentItem, protocol, providerOptions, tools } = options;
  const debugLevel = getDebugLevel();
  const { text } = contentItem;
  if (debugLevel === "stream") {
    logRawChunk(safeToolCallMetadataText(text) ?? "");
  }
  const parserOptions = extractToolCallParserOptions(providerOptions);

  const parsedByProtocol = protocol.parseGeneratedText({
    text,
    tools,
    options: parserOptions,
  });

  if (parsedByProtocol.some((part) => part.type === "tool-call")) {
    return parsedByProtocol;
  }

  if (
    protocol.allowsFallbackRecovery?.(text) === false ||
    (typeof text === "string" &&
      protocol.isDefinitelyPlainGeneratedText?.(text) === true)
  ) {
    return parsedByProtocol;
  }

  const recoveredFromJson = recoverToolCallFromJsonCandidatesWithStatus(
    text,
    tools
  );
  return recoveredFromJson.kind === "none"
    ? parsedByProtocol
    : recoveredFromJson.content;
}

function logParsedContent(content: LanguageModelV4Content[]) {
  if (getDebugLevel() === "stream") {
    for (const part of content) {
      logParsedChunk(part);
    }
  }
}

export async function wrapGenerate({
  protocol,
  doGenerate,
  params,
}: {
  protocol: TCMProtocol;
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
  const tools = decodeOriginalToolsForMiddleware(
    params.providerOptions,
    onError
  );

  if (isToolChoiceActive(params)) {
    return handleToolChoice(doGenerate, params, tools);
  }

  const result = await doGenerate();

  if (result.content.length === 0) {
    recordParsedDebugSummary({
      allText: "",
      debugSummary: params.providerOptions?.toolCallMiddleware?.debugSummary,
      extractToolCallSegments: (segmentParams) =>
        protocol.extractToolCallSegments?.(segmentParams) ?? [],
      onError: onError?.onError,
      toolCalls: [],
      tools,
    });
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
  recordParsedDebugSummary({
    allText: result.content
      .filter(
        (c): c is Extract<LanguageModelV4Content, { type: "text" }> =>
          c.type === "text"
      )
      .map((c) => c.text)
      .join("\n\n"),
    debugSummary: params.providerOptions?.toolCallMiddleware?.debugSummary,
    extractToolCallSegments: (segmentParams) =>
      protocol.extractToolCallSegments?.(segmentParams) ?? [],
    onError: onError?.onError,
    toolCalls: newContent.filter(
      (p): p is Extract<LanguageModelV4Content, { type: "tool-call" }> =>
        p.type === "tool-call"
    ),
    tools,
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
