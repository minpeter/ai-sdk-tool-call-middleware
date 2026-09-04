import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { Qwen3CoderToolParserParamTagParseResult } from "./qwen3coder-param-tag-types";

export type QwenRawArguments = Record<string, string | string[]>;

export interface QwenStreamCallState {
  args: QwenRawArguments;
  buffer: string;
  emittedInput: string;
  endTagName: string;
  hasEmittedStart: boolean;
  partialParam: { name: string; value: string } | null;
  pendingToolInputParts: LanguageModelV4StreamPart[];
  raw: string;
  toolCallId: string;
  toolName: string | null;
}

type ParseParamTagAt = (
  text: string,
  lowerText: string,
  startIndex: number,
  options?: {
    readonly allowEndOfString?: boolean;
    readonly callEndTagNameLower?: string | null;
  }
) => Qwen3CoderToolParserParamTagParseResult | null;

type MergeParamValue = (
  args: QwenRawArguments,
  name: string,
  value: string
) => void;

type EmitToolInputDelta = () => void;

interface ToolInputStartOperation {
  readonly maybeEmitToolInputStart: EmitToolInputDelta;
}

interface ToolInputDeltaOperations extends ToolInputStartOperation {
  readonly maybeEmitToolInputProgress: EmitToolInputDelta;
}

interface ParamTagOperations {
  readonly mergeParamValue: MergeParamValue;
  readonly parseParamTagAt: ParseParamTagAt;
}

interface ConsumeSingleParamTagOptions extends ParamTagOperations {
  readonly allowEndOfString: boolean;
  readonly callState: QwenStreamCallState;
  readonly lastKept: number;
  readonly lower: string;
  readonly lt: number;
  readonly work: string;
}

interface ConsumeParamTagsOptions
  extends ParamTagOperations,
    ToolInputStartOperation {
  readonly allowEndOfString: boolean;
  readonly callState: QwenStreamCallState;
  readonly work: string;
}

interface ParseCallContentOptions
  extends ParamTagOperations,
    ToolInputDeltaOperations {
  readonly allowEndOfString: boolean;
  readonly callState: QwenStreamCallState;
  readonly content: string;
  readonly nameTagRe: RegExp;
  readonly normalizeXmlTextValue: (value: string) => string;
}

function consumeToolNameTag(options: {
  callState: QwenStreamCallState;
  work: string;
  nameTagRe: RegExp;
  normalizeXmlTextValue: (value: string) => string;
  maybeEmitToolInputStart: () => void;
}): string {
  if (options.callState.toolName) {
    return options.work;
  }

  const match = options.nameTagRe.exec(options.work);
  if (!match) {
    return options.work;
  }

  const value = options.normalizeXmlTextValue(match[2] ?? "");
  if (value.trim().length > 0) {
    options.callState.toolName = value;
  }

  const start = match.index ?? 0;
  const consumedLength = match[0]?.length ?? 0;
  const nextWork =
    options.work.slice(0, start) + options.work.slice(start + consumedLength);

  options.maybeEmitToolInputStart();
  return nextWork;
}

function consumeSingleParamTag(options: ConsumeSingleParamTagOptions): {
  keepSlice?: string;
  nextIndex: number;
  nextLastKept: number;
  shouldStop: boolean;
} {
  const parsed = options.parseParamTagAt(
    options.work,
    options.lower,
    options.lt,
    {
      allowEndOfString: options.allowEndOfString,
      callEndTagNameLower: options.callState.endTagName,
    }
  );

  if (!parsed) {
    return {
      nextIndex: options.lt + 1,
      nextLastKept: options.lastKept,
      shouldStop: false,
    };
  }

  if (parsed.kind === "partial") {
    if (parsed.name !== undefined) {
      options.callState.partialParam = {
        name: parsed.name,
        value: parsed.value ?? "",
      };
    }
    return {
      nextIndex: options.lt + 1,
      nextLastKept: options.lastKept,
      shouldStop: true,
    };
  }

  if (parsed.kind === "skip") {
    options.callState.partialParam = null;
    return {
      keepSlice: options.work.slice(options.lastKept, parsed.start),
      nextIndex: parsed.end,
      nextLastKept: parsed.end,
      shouldStop: false,
    };
  }

  options.callState.partialParam = null;
  options.mergeParamValue(options.callState.args, parsed.name, parsed.value);
  return {
    keepSlice: options.work.slice(options.lastKept, parsed.start),
    nextIndex: parsed.end,
    nextLastKept: parsed.end,
    shouldStop: false,
  };
}

function consumeParamTags(options: ConsumeParamTagsOptions): string {
  const lower = options.work.toLowerCase();
  let index = 0;
  let lastKept = 0;
  let pieces: string[] | null = null;

  while (true) {
    const lt = lower.indexOf("<", index);
    if (lt === -1) {
      break;
    }

    const step = consumeSingleParamTag({
      allowEndOfString: options.allowEndOfString,
      callState: options.callState,
      lower,
      lt,
      work: options.work,
      lastKept,
      parseParamTagAt: options.parseParamTagAt,
      mergeParamValue: options.mergeParamValue,
    });

    if (step.keepSlice !== undefined) {
      pieces ??= [];
      pieces.push(step.keepSlice);
    }

    index = step.nextIndex;
    lastKept = step.nextLastKept;
    if (step.shouldStop) {
      break;
    }
  }

  options.maybeEmitToolInputStart();
  if (!pieces) {
    return options.work;
  }
  pieces.push(options.work.slice(lastKept));
  return pieces.join("");
}

export function parseCallContent(options: ParseCallContentOptions): string {
  let work = options.content;
  work = consumeToolNameTag({
    callState: options.callState,
    work,
    nameTagRe: options.nameTagRe,
    normalizeXmlTextValue: options.normalizeXmlTextValue,
    maybeEmitToolInputStart: options.maybeEmitToolInputStart,
  });

  work = consumeParamTags({
    callState: options.callState,
    work,
    allowEndOfString: options.allowEndOfString,
    parseParamTagAt: options.parseParamTagAt,
    mergeParamValue: options.mergeParamValue,
    maybeEmitToolInputStart: options.maybeEmitToolInputStart,
  });

  options.maybeEmitToolInputStart();
  options.maybeEmitToolInputProgress();
  return work;
}
