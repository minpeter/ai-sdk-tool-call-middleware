import { MAX_GLM5_CALL_BODY_LENGTH } from "./glm5-call-types";

export interface Glm5StructuralTag {
  closing: boolean;
  end: number;
  name: "arg_key" | "arg_value";
  start: number;
}

const ARG_TAG_RE = /<\s*(\/?)[ \t\r\n]*(arg_key|arg_value)[ \t\r\n]*>/gi;
const LINE_BREAK_RE = /[\r\n]/;
const POTENTIAL_VALUE_TAGS = [
  "</arg_value>",
  "<arg_key>",
  "</tool_call>",
] as const;
const MAX_GLM5_ARGUMENT_TAGS = 2048;

export function scanGlm5StructuralTags(
  text: string
): Glm5StructuralTag[] | null {
  const tags: Glm5StructuralTag[] = [];
  ARG_TAG_RE.lastIndex = 0;
  let match = ARG_TAG_RE.exec(text);
  while (match) {
    const start = match.index;
    tags.push({
      closing: match[1] === "/",
      end: start + match[0].length,
      name: (match[2] ?? "arg_key").toLowerCase() as Glm5StructuralTag["name"],
      start,
    });
    if (tags.length > MAX_GLM5_ARGUMENT_TAGS) {
      ARG_TAG_RE.lastIndex = 0;
      return null;
    }
    match = ARG_TAG_RE.exec(text);
  }
  ARG_TAG_RE.lastIndex = 0;
  return tags;
}

export function hasExplicitlyClosedGlm5TaggedBody(body: string): boolean {
  if (body.length > MAX_GLM5_CALL_BODY_LENGTH) {
    return false;
  }
  const tags = scanGlm5StructuralTags(body);
  if (!(tags && tags.length > 0 && tags.length % 4 === 0)) {
    return false;
  }
  const [firstTag] = tags;
  if (!(firstTag && body.slice(0, firstTag.start).trim().length > 0)) {
    return false;
  }

  let consumedUntil = firstTag.start;
  for (let index = 0; index < tags.length; index += 4) {
    const [keyOpen, keyClose, valueOpen, valueClose] = tags.slice(
      index,
      index + 4
    );
    if (
      keyOpen?.name !== "arg_key" ||
      keyOpen.closing ||
      keyClose?.name !== "arg_key" ||
      !keyClose.closing ||
      valueOpen?.name !== "arg_value" ||
      valueOpen.closing ||
      valueClose?.name !== "arg_value" ||
      !valueClose.closing ||
      body.slice(consumedUntil, keyOpen.start).trim().length > 0 ||
      body.slice(keyOpen.end, keyClose.start).trim().length === 0 ||
      body.slice(keyClose.end, valueOpen.start).trim().length > 0
    ) {
      return false;
    }
    consumedUntil = valueClose.end;
  }
  return body.slice(consumedUntil).trim().length === 0;
}

export function findGlm5Tag(
  tags: Glm5StructuralTag[],
  from: number,
  name: Glm5StructuralTag["name"],
  closing: boolean
): number {
  for (let index = from; index < tags.length; index += 1) {
    const tag = tags[index];
    if (tag?.name === name && tag.closing === closing) {
      return index;
    }
  }
  return -1;
}

export function findGlm5StructuralValueClose(
  body: string,
  tags: Glm5StructuralTag[],
  from: number
): number {
  for (let index = from; index < tags.length; index += 1) {
    const tag = tags[index];
    if (!(tag?.name === "arg_value" && tag.closing)) {
      continue;
    }
    const next = tags[index + 1];
    const gap = body.slice(tag.end, next?.start ?? body.length);
    if (gap.trim().length > 0) {
      continue;
    }
    if (!next || (next.name === "arg_key" && !next.closing)) {
      return index;
    }
  }
  return -1;
}

export function glm5PartialTagOverlap(value: string): number {
  const lower = value.toLowerCase();
  let best = 0;
  for (const tag of POTENTIAL_VALUE_TAGS) {
    const max = Math.min(lower.length, tag.length - 1);
    for (let length = max; length > best; length -= 1) {
      if (lower.endsWith(tag.slice(0, length))) {
        best = length;
        break;
      }
    }
  }
  return best;
}

export function extractRawGlm5ToolName(options: {
  body: string;
  complete: boolean;
  tags: Glm5StructuralTag[];
}): { argsStart: number; rawName: string } | null {
  const firstTagStart = options.tags[0]?.start ?? -1;
  const newline = options.body.search(LINE_BREAK_RE);
  const boundaries = [firstTagStart, newline].filter((index) => index >= 0);
  if (boundaries.length === 0 && !options.complete) {
    return null;
  }
  const argsStart =
    boundaries.length > 0 ? Math.min(...boundaries) : options.body.length;
  const rawName = options.body.slice(0, argsStart).trim();
  return rawName ? { argsStart, rawName } : null;
}
