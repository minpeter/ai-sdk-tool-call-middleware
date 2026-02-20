export interface QwenStreamCallState {
  args: Record<string, unknown>;
  buffer: string;
  emittedInput: string;
  endTagName: string;
  hasEmittedStart: boolean;
  partialParam: { name: string; value: string } | null;
  raw: string;
  toolCallId: string;
  toolName: string | null;
}

export type QwenParamTagParseResult =
  | {
      kind: "match";
      start: number;
      end: number;
      name: string;
      value: string;
    }
  | {
      kind: "partial";
      start: number;
      openEnd: number | null;
      name?: string;
      value?: string;
    };

export function consumeToolNameTag(options: {
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

export function consumeSingleParamTag(options: {
  allowEndOfString: boolean;
  callState: QwenStreamCallState;
  lastKept: number;
  lower: string;
  lt: number;
  work: string;
  parseParamTagAt: (
    text: string,
    lowerText: string,
    startIndex: number,
    options?: {
      allowEndOfString?: boolean;
      callEndTagNameLower?: string | null;
    }
  ) => QwenParamTagParseResult | null;
  mergeParamValue: (
    args: Record<string, unknown>,
    name: string,
    value: string
  ) => void;
}): {
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

  options.callState.partialParam = null;
  options.mergeParamValue(options.callState.args, parsed.name, parsed.value);
  return {
    keepSlice: options.work.slice(options.lastKept, parsed.start),
    nextIndex: parsed.end,
    nextLastKept: parsed.end,
    shouldStop: false,
  };
}

export function consumeParamTags(options: {
  callState: QwenStreamCallState;
  work: string;
  allowEndOfString: boolean;
  parseParamTagAt: (
    text: string,
    lowerText: string,
    startIndex: number,
    options?: {
      allowEndOfString?: boolean;
      callEndTagNameLower?: string | null;
    }
  ) => QwenParamTagParseResult | null;
  mergeParamValue: (
    args: Record<string, unknown>,
    name: string,
    value: string
  ) => void;
  maybeEmitToolInputStart: () => void;
}): string {
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

export function parseCallContent(options: {
  callState: QwenStreamCallState;
  content: string;
  allowEndOfString: boolean;
  nameTagRe: RegExp;
  normalizeXmlTextValue: (value: string) => string;
  parseParamTagAt: (
    text: string,
    lowerText: string,
    startIndex: number,
    options?: {
      allowEndOfString?: boolean;
      callEndTagNameLower?: string | null;
    }
  ) => QwenParamTagParseResult | null;
  mergeParamValue: (
    args: Record<string, unknown>,
    name: string,
    value: string
  ) => void;
  maybeEmitToolInputStart: () => void;
  maybeEmitToolInputProgress: () => void;
}): string {
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
