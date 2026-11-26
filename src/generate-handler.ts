import type {
  LanguageModelV4,
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
  LanguageModelV4ToolCall,
  SharedV4Warning,
} from "@ai-sdk/provider";
import { getProtocolGeneratedTextFastPaths } from "./core/protocols/protocol-fast-paths";
import type { TCMCoreProtocol } from "./core/protocols/protocol-interface";
import { coerceToolCallPart } from "./core/utils/coercion/tool-call-coercion";
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
import { generateToolCallId } from "./core/utils/id";
import { extractOnErrorOption } from "./core/utils/on-error";
import {
  safeToolCallMetadataText,
  safeToolCallMetadataValue,
} from "./core/utils/protocol-utils";
import {
  createDroppedProviderToolWarnings,
  decodeOriginalToolsForMiddleware,
  getToolCallMiddlewareOptions,
  getToolChoiceExpectedToolName,
  isToolChoiceActive,
  isToolChoiceNone,
  type ToolCallMiddlewareProviderOptions,
} from "./core/utils/provider-options";
import { recoverToolCallFromJsonCandidatesWithStatus } from "./core/utils/recovery/generated-text-json-recovery";
import { carryTextPartAnnotations } from "./core/utils/text-citations";
import {
  findToolChoiceResultText,
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
        {
          toolName: toolCall.toolName,
          input: safeToolCallMetadataValue(toolCall.input),
        },
      ]);
    } catch {
      // ignore
    }
  } else if (getDebugLevel() === "parse") {
    logParsedSummary({ toolCalls: [toolCall], originalText: originText });
  }
}

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

  const debugSummary = params.providerOptions?.toolCallMiddleware?.debugSummary;
  logDebugSummary(debugSummary, toolCall, originText);

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
  protocol: TCMCoreProtocol,
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
  protocol: TCMCoreProtocol;
  providerOptions?: ToolCallMiddlewareProviderOptions;
  tools: LanguageModelV4FunctionTool[];
}): LanguageModelV4Content[] {
  const { contentItem, protocol, providerOptions, tools } = options;
  const debugLevel = getDebugLevel();
  if (debugLevel === "stream") {
    logRawChunk(safeToolCallMetadataText(contentItem.text) ?? "");
  }
  const parserOptions = {
    ...extractOnErrorOption(providerOptions),
    ...getToolCallMiddlewareOptions(providerOptions),
  };

  let evaluatedParser: unknown;
  let evaluatedText: unknown;
  let evaluatedRecoveryText: unknown;
  let synthesizedPlainText: LanguageModelV4Content[] | undefined;
  let recoveryTextIsMaterialized = false;
  if (debugLevel === "off") {
    // Preserve CallExpression evaluation order for every protocol: evaluate
    // the method/getter first and its text argument second, then ask whether
    // that already-materialized callable is an exact built-in parser closure.
    evaluatedParser = protocol.parseGeneratedText;
    evaluatedText = contentItem.text;
    const fastPaths = (parserOptions as Record<string, unknown>).debugSummary
      ? undefined
      : getProtocolGeneratedTextFastPaths(evaluatedParser);
    if (
      fastPaths &&
      typeof evaluatedText === "string" &&
      fastPaths.isDefinitelyPlainGeneratedText(evaluatedText)
    ) {
      synthesizedPlainText = [{ type: "text", text: evaluatedText }];
      evaluatedRecoveryText = contentItem.text;
      recoveryTextIsMaterialized = true;
      if (evaluatedRecoveryText === evaluatedText) {
        return synthesizedPlainText;
      }
    }
  }
  let parsedByProtocol: LanguageModelV4Content[];
  if (synthesizedPlainText) {
    // The exact parser would have produced this value before the second text
    // getter. Keeping it avoids moving parser work after getter side effects
    // when recovery observes a different second value.
    parsedByProtocol = synthesizedPlainText;
  } else if (debugLevel !== "off") {
    parsedByProtocol = protocol.parseGeneratedText({
      text: contentItem.text,
      tools,
      options: parserOptions,
    });
  } else if (typeof evaluatedParser === "function") {
    parsedByProtocol = Reflect.apply(evaluatedParser, protocol, [
      {
        text: evaluatedText,
        tools,
        options: parserOptions,
      },
    ]) as LanguageModelV4Content[];
  } else {
    throw new TypeError("protocol.parseGeneratedText is not a function");
  }

  if (parsedByProtocol.some((part) => part.type === "tool-call")) {
    return parsedByProtocol;
  }

  const recoveryText = recoveryTextIsMaterialized
    ? (evaluatedRecoveryText as string)
    : contentItem.text;
  if (protocol.allowsGeneratedTextJsonRecovery?.(recoveryText) === false) {
    return parsedByProtocol;
  }

  const recoveredFromJson = recoverToolCallFromJsonCandidatesWithStatus(
    recoveryText,
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

function computeDebugSummary(options: {
  result: { content: LanguageModelV4Content[] };
  newContent: LanguageModelV4Content[];
  protocol: TCMCoreProtocol;
  tools: LanguageModelV4FunctionTool[];
  providerOptions?: ToolCallMiddlewareProviderOptions;
}) {
  const { result, newContent, protocol, tools, providerOptions } = options;
  const dbg = providerOptions?.toolCallMiddleware?.debugSummary;
  const debugLevel = getDebugLevel();
  if (!dbg && debugLevel !== "parse") {
    return;
  }
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
  const originalText = safeToolCallMetadataText(segments.join("\n\n")) ?? "";

  const toolCalls = newContent.filter(
    (p): p is Extract<LanguageModelV4Content, { type: "tool-call" }> =>
      p.type === "tool-call"
  );

  if (dbg) {
    dbg.originalText = originalText;
    try {
      dbg.toolCalls = JSON.stringify(
        toolCalls.map((tc) => ({
          toolName: tc.toolName,
          input: safeToolCallMetadataValue(tc.input),
        }))
      );
    } catch {
      // ignore JSON failure
    }
  } else if (debugLevel === "parse") {
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
  const tools = decodeOriginalToolsForMiddleware(
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
