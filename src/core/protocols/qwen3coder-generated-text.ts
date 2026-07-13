import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { generateToolCallId } from "../utils/id";
import {
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import { stringifyToolInputWithSchema } from "../utils/tool-input-streaming";
import type { ParserOptions } from "./protocol-interface";
import {
  extractQwen3CoderToolNameFromMarkup,
  findImplicitCallOpenIndices,
  parseQwen3CoderToolParserToolCallSegment,
  parseSingleFunctionCallXml,
  splitImplicitCallAndTail,
} from "./qwen3coder-call-parsing";
import {
  CALL_BLOCK_RE,
  stripLeadingToolCallCloseTags,
  stripTrailingToolCallCloseTags,
  TOOL_CALL_BLOCK_RE,
  TOOL_CALL_CLOSE_RE,
} from "./qwen3coder-call-syntax";
import { emitTextWithSensitiveStandaloneParamDrops } from "./qwen3coder-sensitive-standalone-param";

export function parseQwen3CoderGeneratedText({
  text,
  tools,
  options,
}: {
  text: string;
  tools: LanguageModelV4FunctionTool[];
  options?: ParserOptions;
}): LanguageModelV4Content[] {
  const processedElements: LanguageModelV4Content[] = [];

  const emitToolCalls = (
    calls: Array<{ toolName: string; args: Record<string, unknown> }>
  ) => {
    for (const call of calls) {
      processedElements.push({
        type: "tool-call",
        toolCallId: generateToolCallId(),
        toolName: call.toolName,
        input: stringifyToolInputWithSchema({
          tools,
          toolName: call.toolName,
          args: call.args,
        }),
      });
    }
  };

  const emitToolCallParseFailureAsText = (
    raw: string,
    message: string,
    toolName: string | null | undefined,
    error?: unknown
  ) => {
    options?.onError?.(message, {
      toolCall: safeToolCallMetadataText(raw),
      toolName: toolName ?? undefined,
      toolCallId: generateToolCallId(),
      dropReason: "malformed-tool-call-body",
      ...(error === undefined
        ? {}
        : { error: safeToolCallMetadataError(error, raw) }),
    });
    if (toolCallTextHasPrototypeSensitiveKey(raw)) {
      return;
    }
    processedElements.push({ type: "text", text: raw });
  };

  const tryEmitToolCalls = (
    calls: Array<{ toolName: string; args: Record<string, unknown> }>,
    fallbackText: string,
    message: string
  ): boolean => {
    try {
      emitToolCalls(calls);
      return true;
    } catch (error) {
      emitToolCallParseFailureAsText(
        fallbackText,
        message,
        calls[0]?.toolName,
        error
      );
      return false;
    }
  };

  const pushText = (value: string) => {
    if (value.length === 0) {
      return;
    }
    processedElements.push({ type: "text", text: value });
  };

  const pushRecoveredTrailingText = (value: string, raw: string) => {
    const trailingText = stripTrailingToolCallCloseTags(
      stripLeadingToolCallCloseTags(value)
    );
    if (trailingText.length === 0) {
      return;
    }
    if (toolCallTextHasPrototypeSensitiveKey(trailingText)) {
      const droppedBoundedSpan = emitTextWithSensitiveStandaloneParamDrops({
        text: trailingText,
        emitText: pushText,
        onSensitiveText: (sensitiveText) => {
          options?.onError?.("Dropped sensitive Qwen3CoderToolParser text.", {
            toolCall: safeToolCallMetadataText(sensitiveText),
            toolName: extractQwen3CoderToolNameFromMarkup(raw) ?? undefined,
            toolCallId: generateToolCallId(),
            dropReason: "sensitive-tool-call-trailing-text",
          });
        },
      });
      if (droppedBoundedSpan) {
        return;
      }
      options?.onError?.("Dropped sensitive Qwen3CoderToolParser text.", {
        toolCall: safeToolCallMetadataText(raw),
        toolName: extractQwen3CoderToolNameFromMarkup(raw) ?? undefined,
        toolCallId: generateToolCallId(),
        dropReason: "sensitive-tool-call-trailing-text",
      });
      return;
    }
    pushText(trailingText);
  };

  const tryEmitToolCallSegment = (
    segment: string,
    fallbackText: string = segment
  ): boolean => {
    const parsedCalls = parseQwen3CoderToolParserToolCallSegment(
      segment,
      tools
    );
    if (!parsedCalls) {
      emitToolCallParseFailureAsText(
        fallbackText,
        "Could not process Qwen3CoderToolParser XML tool call; keeping original text.",
        extractQwen3CoderToolNameFromMarkup(segment)
      );
      return false;
    }
    return tryEmitToolCalls(
      parsedCalls,
      fallbackText,
      "Could not process Qwen3CoderToolParser XML tool call; keeping original text."
    );
  };

  const emitWrapperlessCallParseFailureAsText = (raw: string) => {
    emitToolCallParseFailureAsText(
      raw,
      "Could not process Qwen3CoderToolParser <function> call; keeping original text.",
      extractQwen3CoderToolNameFromMarkup(raw)
    );
  };

  const tryParseCallBlocksWithoutWrapperByImplicitStarts = (
    sourceText: string,
    starts: number[]
  ): boolean => {
    let index = 0;
    for (let i = 0; i < starts.length; i += 1) {
      const startIndex = starts[i] ?? -1;
      if (startIndex < 0) {
        continue;
      }
      const endIndex = starts[i + 1] ?? sourceText.length;

      const leadingText = sourceText.slice(index, startIndex);
      pushRecoveredTrailingText(leadingText, leadingText);

      const full = sourceText.slice(startIndex, endIndex);
      const { callContent, trailingText } = splitImplicitCallAndTail(
        full,
        tools
      );
      const parsed = parseSingleFunctionCallXml(callContent, null, tools);
      if (parsed) {
        if (
          tryEmitToolCalls(
            [parsed],
            full,
            "Could not process Qwen3CoderToolParser <function> call; keeping original text."
          )
        ) {
          pushRecoveredTrailingText(trailingText, full);
        }
      } else {
        emitWrapperlessCallParseFailureAsText(full);
      }

      index = endIndex;
    }

    const trailingText = sourceText.slice(index);
    pushRecoveredTrailingText(trailingText, trailingText);
    return true;
  };

  const tryParseCallBlocksWithoutWrapperByMatches = (
    sourceText: string,
    matches: RegExpMatchArray[]
  ): boolean => {
    let index = 0;
    for (const match of matches) {
      const [full] = match;
      const startIndex = match.index ?? -1;
      if (!full || startIndex < 0) {
        continue;
      }

      const leadingText = sourceText.slice(index, startIndex);
      pushRecoveredTrailingText(leadingText, leadingText);

      const parsed = parseSingleFunctionCallXml(full, null, tools);
      if (parsed) {
        tryEmitToolCalls(
          [parsed],
          full,
          "Could not process Qwen3CoderToolParser <function> call; keeping original text."
        );
      } else {
        emitWrapperlessCallParseFailureAsText(full);
      }
      index = startIndex + full.length;
    }

    const trailing = sourceText.slice(index);
    const trailingStarts = findImplicitCallOpenIndices(trailing.toLowerCase());
    if (trailingStarts.length > 0) {
      return tryParseCallBlocksWithoutWrapperByImplicitStarts(
        trailing,
        trailingStarts
      );
    }

    pushRecoveredTrailingText(trailing, trailing);
    return true;
  };

  // vLLM reference (Qwen3CoderToolParser): fallback extraction still attempts to
  // parse when XML wrapper tags are missing (raw output starts with <function=...>).
  // https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3coder_tool_parser.py#L271-L289
  // https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/tests/tool_parsers/test_qwen3coder_tool_parser.py#L356-L377
  const tryParseCallBlocksWithoutWrapperText = (
    sourceText: string
  ): boolean => {
    const matches = Array.from(sourceText.matchAll(CALL_BLOCK_RE));
    if (matches.length > 0) {
      return tryParseCallBlocksWithoutWrapperByMatches(sourceText, matches);
    }

    const starts = findImplicitCallOpenIndices(sourceText.toLowerCase());
    if (starts.length === 0) {
      return false;
    }
    return tryParseCallBlocksWithoutWrapperByImplicitStarts(sourceText, starts);
  };

  const pushTextOrParseWrapperlessCalls = (segment: string) => {
    if (segment.length === 0) {
      return;
    }
    if (!tryParseCallBlocksWithoutWrapperText(segment)) {
      pushRecoveredTrailingText(segment, segment);
    }
  };

  // vLLM reference (Qwen3CoderToolParser): allow trailing, incomplete <tool_call>
  // blocks ("<tool_call>...$"), and still attempt best-effort parsing.
  // https://github.com/vllm-project/vllm/blob/f13e86d8ddf81c638bacce6f8876cf6acf421d58/vllm/tool_parsers/qwen3coder_tool_parser.py#L55-L61
  const handleCompleteToolCallRemainder = (remainder: string) => {
    if (!remainder) {
      return;
    }
    const lowerRemainder = remainder.toLowerCase();
    const trailingIndex = lowerRemainder.indexOf("<tool_call");
    if (trailingIndex === -1) {
      pushTextOrParseWrapperlessCalls(remainder);
      return;
    }

    pushTextOrParseWrapperlessCalls(remainder.slice(0, trailingIndex));
    const trailing = remainder.slice(trailingIndex);
    const synthetic = TOOL_CALL_CLOSE_RE.test(trailing)
      ? trailing
      : `${trailing}</tool_call>`;
    tryEmitToolCallSegment(synthetic, trailing);
  };

  const tryParseCompleteToolCallBlocks = (): boolean => {
    const matches = Array.from(text.matchAll(TOOL_CALL_BLOCK_RE));
    if (matches.length === 0) {
      return false;
    }

    let index = 0;
    for (const match of matches) {
      const [full] = match;
      const startIndex = match.index ?? -1;
      if (!full || startIndex < 0) {
        continue;
      }

      pushTextOrParseWrapperlessCalls(text.slice(index, startIndex));
      tryEmitToolCallSegment(full);
      index = startIndex + full.length;
    }

    handleCompleteToolCallRemainder(text.slice(index));
    return true;
  };

  const tryParseIncompleteToolCall = (): boolean => {
    const lowerText = text.toLowerCase();
    const startIndex = lowerText.indexOf("<tool_call");
    if (startIndex === -1) {
      return false;
    }

    pushTextOrParseWrapperlessCalls(text.slice(0, startIndex));
    const trailing = text.slice(startIndex);
    const synthetic = TOOL_CALL_CLOSE_RE.test(trailing)
      ? trailing
      : `${trailing}</tool_call>`;
    tryEmitToolCallSegment(synthetic, trailing);
    return true;
  };

  const tryParseCallBlocksWithoutWrapper = (): boolean =>
    tryParseCallBlocksWithoutWrapperText(text);

  const tryParseSingleFunctionCall = (): boolean => {
    const lowerText = text.toLowerCase();
    const startIndex = lowerText.indexOf("<function");
    if (startIndex === -1) {
      return false;
    }

    const leadingText = stripTrailingToolCallCloseTags(
      text.slice(0, startIndex)
    );
    pushRecoveredTrailingText(leadingText, leadingText);
    const trailing = stripLeadingToolCallCloseTags(text.slice(startIndex));
    const parsed = parseSingleFunctionCallXml(trailing, null, tools);
    if (!parsed) {
      emitWrapperlessCallParseFailureAsText(trailing);
      return true;
    }

    tryEmitToolCalls(
      [parsed],
      trailing,
      "Could not process Qwen3CoderToolParser <function> call; keeping original text."
    );
    return true;
  };

  if (tryParseCompleteToolCallBlocks()) {
    return processedElements;
  }
  if (tryParseIncompleteToolCall()) {
    return processedElements;
  }
  if (tryParseCallBlocksWithoutWrapper()) {
    return processedElements;
  }
  if (tryParseSingleFunctionCall()) {
    return processedElements;
  }

  if (text.length === 0) {
    return [{ type: "text", text }];
  }
  pushRecoveredTrailingText(text, text);
  return processedElements;
}
