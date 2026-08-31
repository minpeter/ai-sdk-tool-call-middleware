import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { generateToolCallId } from "../utils/id";
import {
  consumeMarkdownCodeText,
  createMarkdownCodeContext,
  markdownCodeContextSuppressesToolCall,
} from "../utils/markdown-code-context";
import {
  addTextSegment,
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import { toolCallTextHasPrototypeSensitiveKey } from "../utils/prototype-sensitive-keys";
import { shouldEmitRawToolCallTextOnError } from "../utils/tool-input-streaming";
import { parseGlm5AnchoredBareToolCall } from "./glm5-bare-tool-call";
import {
  parseGlm5CallBody,
  type ResolvedGlm5ProtocolOptions,
  stringifyGlm5CallInput,
} from "./glm5-call-parsing";
import {
  findGlm5ToolCallOpen,
  selectClosedGlm5Call,
} from "./glm5-segment-selection";
import type { ParserOptions } from "./protocol-interface";

function reportRecovery(
  options: ParserOptions | undefined,
  raw: string,
  toolName: string,
  recoveryCodes: string[]
): void {
  if (recoveryCodes.length === 0) {
    return;
  }
  options?.onError?.("Recovered malformed GLM-5.2 tool call.", {
    recoveryCodes,
    toolCall: safeToolCallMetadataText(raw),
    toolName,
  });
}

function reportFailure(
  options: ParserOptions | undefined,
  raw: string,
  error?: unknown
): void {
  options?.onError?.("Could not parse GLM-5.2 tool call.", {
    dropReason: "malformed-glm5-tool-call",
    ...(error === undefined
      ? {}
      : { error: safeToolCallMetadataError(error, raw) }),
    toolCall: safeToolCallMetadataText(raw),
  });
}

function appendRawFallback(
  output: LanguageModelV4Content[],
  raw: string,
  options?: ParserOptions
): void {
  if (
    shouldEmitRawToolCallTextOnError(options) &&
    !toolCallTextHasPrototypeSensitiveKey(raw)
  ) {
    addTextSegment(raw, output);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: candidate selection, fail-closed recovery, and text preservation require explicit branches.
export function parseGlm5GeneratedText(options: {
  parserOptions?: ParserOptions;
  protocolOptions: ResolvedGlm5ProtocolOptions;
  text: string;
  tools: LanguageModelV4FunctionTool[];
}): LanguageModelV4Content[] {
  const output: LanguageModelV4Content[] = [];
  const markdownContext = createMarkdownCodeContext();
  let cursor = 0;

  while (cursor < options.text.length) {
    const open = findGlm5ToolCallOpen(options.text, cursor);
    if (!open) {
      addTextSegment(options.text.slice(cursor), output);
      break;
    }
    const leadingText = options.text.slice(cursor, open.start);
    consumeMarkdownCodeText(markdownContext, leadingText);
    const insideMarkdownCode =
      markdownCodeContextSuppressesToolCall(markdownContext);
    addTextSegment(leadingText, output);

    const selected = selectClosedGlm5Call({
      open,
      protocolOptions: options.protocolOptions,
      text: options.text,
      tools: options.tools,
    });
    if (insideMarkdownCode) {
      const rawEnd = selected?.close.end ?? options.text.length;
      const rawText = options.text.slice(open.start, rawEnd);
      consumeMarkdownCodeText(markdownContext, rawText);
      addTextSegment(rawText, output);
      cursor = rawEnd;
      if (!selected) {
        break;
      }
      continue;
    }
    const close = selected?.close ?? null;
    const complete = close !== null;
    if (selected?.rejected) {
      const raw = options.text.slice(open.start, selected.close.end);
      reportFailure(options.parserOptions, raw);
      appendRawFallback(output, raw, options.parserOptions);
      cursor = selected.close.end;
      continue;
    }
    const nestedOpenWithoutClose =
      !complete && findGlm5ToolCallOpen(options.text, open.end) !== null;
    if (nestedOpenWithoutClose) {
      const raw = options.text.slice(open.start);
      reportFailure(options.parserOptions, raw);
      appendRawFallback(output, raw, options.parserOptions);
      break;
    }
    if (!(complete || options.protocolOptions.recoverIncompleteToolCalls)) {
      const raw = options.text.slice(open.start);
      reportFailure(options.parserOptions, raw);
      appendRawFallback(output, raw, options.parserOptions);
      break;
    }

    const bodyEnd = close?.start ?? options.text.length;
    const rawEnd = close?.end ?? options.text.length;
    const raw = options.text.slice(open.start, rawEnd);
    const parsed =
      selected === null
        ? parseGlm5CallBody({
            body: options.text.slice(open.end, bodyEnd),
            complete: true,
            protocolOptions: options.protocolOptions,
            tools: options.tools,
          })
        : selected.parsed;
    if (parsed) {
      try {
        const input = stringifyGlm5CallInput(parsed, options.tools);
        output.push({
          type: "tool-call",
          input,
          toolCallId: generateToolCallId(),
          toolName: parsed.toolName,
        });
        reportRecovery(options.parserOptions, raw, parsed.toolName, [
          ...parsed.recoveries,
          ...(complete ? [] : ["recovered-missing-tool-call-close"]),
        ]);
      } catch (error) {
        reportFailure(options.parserOptions, raw, error);
        appendRawFallback(output, raw, options.parserOptions);
      }
    } else {
      reportFailure(options.parserOptions, raw);
      appendRawFallback(output, raw, options.parserOptions);
    }
    cursor = rawEnd;
    if (!complete) {
      break;
    }
  }

  if (output.some((part) => part.type === "tool-call")) {
    return output;
  }

  const bareCall = parseGlm5AnchoredBareToolCall({
    text: options.text,
    tools: options.tools,
  });
  if (!bareCall) {
    return output;
  }
  return [
    {
      type: "tool-call",
      input: bareCall.input,
      toolCallId: generateToolCallId(),
      toolName: bareCall.toolName,
    },
  ];
}
