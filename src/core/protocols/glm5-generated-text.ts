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
import type {
  ClosedGlm5CallSelection,
  Glm5TagMatch,
} from "./glm5-segment-selection";
import {
  findGlm5ToolCallOpen,
  selectClosedGlm5Call,
} from "./glm5-segment-selection";
import type { ParserOptions } from "./protocol-interface";

interface Glm5GeneratedTextOptions {
  readonly parserOptions?: ParserOptions;
  readonly protocolOptions: ResolvedGlm5ProtocolOptions;
  readonly text: string;
  readonly tools: LanguageModelV4FunctionTool[];
}

interface CanonicalParseState {
  cursor: number;
  readonly markdownContext: ReturnType<typeof createMarkdownCodeContext>;
  readonly output: LanguageModelV4Content[];
}

interface CanonicalCandidate {
  readonly insideMarkdownCode: boolean;
  readonly open: Glm5TagMatch;
  readonly selected: ClosedGlm5CallSelection | null;
}

interface ParsedCallOutput {
  readonly complete: boolean;
  readonly options: Glm5GeneratedTextOptions;
  readonly output: LanguageModelV4Content[];
  readonly parsed: NonNullable<ReturnType<typeof parseGlm5CallBody>>;
  readonly raw: string;
}

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
  error?: Error
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

function appendFailure(
  options: Glm5GeneratedTextOptions,
  output: LanguageModelV4Content[],
  raw: string
): void {
  reportFailure(options.parserOptions, raw);
  appendRawFallback(output, raw, options.parserOptions);
}

function appendParsedCall({
  complete,
  options,
  output,
  parsed,
  raw,
}: ParsedCallOutput): void {
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
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    reportFailure(options.parserOptions, raw, error);
    appendRawFallback(output, raw, options.parserOptions);
  }
}

function processCanonicalCandidate(
  options: Glm5GeneratedTextOptions,
  state: CanonicalParseState,
  candidate: CanonicalCandidate
): boolean {
  const { insideMarkdownCode, open, selected } = candidate;
  if (insideMarkdownCode) {
    const rawEnd = selected?.close.end ?? options.text.length;
    const rawText = options.text.slice(open.start, rawEnd);
    consumeMarkdownCodeText(state.markdownContext, rawText);
    addTextSegment(rawText, state.output);
    state.cursor = rawEnd;
    return selected === null;
  }

  const close = selected?.close ?? null;
  const complete = close !== null;
  if (selected?.rejected) {
    const raw = options.text.slice(open.start, selected.close.end);
    appendFailure(options, state.output, raw);
    state.cursor = selected.close.end;
    return false;
  }
  const nestedOpenWithoutClose =
    !complete && findGlm5ToolCallOpen(options.text, open.end) !== null;
  if (
    nestedOpenWithoutClose ||
    !(complete || options.protocolOptions.recoverIncompleteToolCalls)
  ) {
    appendFailure(options, state.output, options.text.slice(open.start));
    return true;
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
    appendParsedCall({
      complete,
      options,
      output: state.output,
      parsed,
      raw,
    });
  } else {
    appendFailure(options, state.output, raw);
  }
  state.cursor = rawEnd;
  return !complete;
}

function parseCanonicalCalls(
  options: Glm5GeneratedTextOptions
): LanguageModelV4Content[] {
  const state: CanonicalParseState = {
    cursor: 0,
    markdownContext: createMarkdownCodeContext(),
    output: [],
  };
  while (state.cursor < options.text.length) {
    const open = findGlm5ToolCallOpen(options.text, state.cursor);
    if (!open) {
      addTextSegment(options.text.slice(state.cursor), state.output);
      break;
    }
    const leadingText = options.text.slice(state.cursor, open.start);
    consumeMarkdownCodeText(state.markdownContext, leadingText);
    addTextSegment(leadingText, state.output);
    const selected = selectClosedGlm5Call({
      open,
      protocolOptions: options.protocolOptions,
      text: options.text,
      tools: options.tools,
    });
    if (
      processCanonicalCandidate(options, state, {
        insideMarkdownCode: markdownCodeContextSuppressesToolCall(
          state.markdownContext
        ),
        open,
        selected,
      })
    ) {
      break;
    }
  }
  return state.output;
}

export function parseGlm5GeneratedText(
  options: Glm5GeneratedTextOptions
): LanguageModelV4Content[] {
  const output = parseCanonicalCalls(options);
  if (output.some((part) => part.type === "tool-call")) {
    return output;
  }

  const bareCall = parseGlm5AnchoredBareToolCall({
    text: options.text,
    tools: options.tools,
  });
  return bareCall
    ? [
        {
          type: "tool-call",
          input: bareCall.input,
          toolCallId: generateToolCallId(),
          toolName: bareCall.toolName,
        },
      ]
    : output;
}
