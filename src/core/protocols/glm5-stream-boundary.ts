import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { appendGlm5ScannedStreamBody } from "./glm5-stream-close-scanner";
import type { Glm5StreamLifecycle } from "./glm5-stream-lifecycle";
import type { ActiveGlm5Call } from "./glm5-stream-state";

type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;

const TOOL_CALL_CLOSE_AT_START_RE = /^<\s*\/\s*tool_call\s*>/i;
const TAG_NAME_CHARACTER_RE = /[A-Za-z_]/u;
const TOOL_CALL_NAME = "tool_call";
const WHITESPACE_RE = /\s/u;

function isPotentialToolCallClosePrefix(text: string): boolean {
  if (!text.startsWith("<")) {
    return false;
  }
  let cursor = 1;
  while (WHITESPACE_RE.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  if (text[cursor] === undefined) {
    return true;
  }
  if (text[cursor] !== "/") {
    return false;
  }
  cursor += 1;
  while (WHITESPACE_RE.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  const nameStart = cursor;
  while (TAG_NAME_CHARACTER_RE.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  const name = text.slice(nameStart, cursor).toLowerCase();
  if (!TOOL_CALL_NAME.startsWith(name) || name !== TOOL_CALL_NAME) {
    return cursor === text.length && TOOL_CALL_NAME.startsWith(name);
  }
  while (WHITESPACE_RE.test(text[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor === text.length;
}

export function resolveGlm5BodyLimitBoundary({
  bodyLengthLimit,
  call,
  controller,
  lifecycle,
  textBuffer,
}: {
  bodyLengthLimit: number;
  call: ActiveGlm5Call;
  controller: StreamController;
  lifecycle: Glm5StreamLifecycle;
  textBuffer: string;
}): { stop: boolean; textBuffer: string } {
  if (
    call.body.length !== bodyLengthLimit ||
    textBuffer.length === 0 ||
    call.markdownCodePrefixed
  ) {
    return { stop: false, textBuffer };
  }

  const close = TOOL_CALL_CLOSE_AT_START_RE.exec(textBuffer)?.[0];
  if (close) {
    appendGlm5ScannedStreamBody(call, close);
    return { stop: false, textBuffer: textBuffer.slice(close.length) };
  }
  if (isPotentialToolCallClosePrefix(textBuffer)) {
    lifecycle.updateToolInputProgress(controller, call);
  } else {
    lifecycle.markCallOversized(controller, call);
  }
  return { stop: true, textBuffer };
}
