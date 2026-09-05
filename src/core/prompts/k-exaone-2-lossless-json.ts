import { parse } from "../../rjson/parse";
import { defineReviver } from "../../rjson/parser-types";
import {
  createKExaone2JsonSyntaxError,
  encodeKExaone2JsonString,
  K_EXAONE_2_HISTORY_KEY_PREFIX,
  K_EXAONE_2_HISTORY_NUMBER_PREFIX,
  K_EXAONE_2_HISTORY_STRING_PREFIX,
  K_EXAONE_2_JSON_NUMBER_RE,
  KExaone2HistoryNumber,
  readKExaone2JsonString,
  skipKExaone2JsonWhitespace,
} from "./k-exaone-2-lossless-json-tokens";
import type { KExaone2Value } from "./k-exaone-2-native-json";
import {
  K_EXAONE_2_MAX_JSON_INPUT_LENGTH,
  K_EXAONE_2_MAX_NESTING_DEPTH,
  K_EXAONE_2_MAX_SERIALIZATION_WORK_ITEMS,
  KExaone2SerializationError,
} from "./k-exaone-2-serialization-error";

type ArrayState = "comma-or-end" | "value-or-end";
type ObjectState = "colon" | "comma-or-end" | "key-or-end" | "value";
type ParserFrame =
  | { readonly kind: "array"; state: ArrayState }
  | { readonly kind: "object"; state: ObjectState };
interface RewriteContext {
  readonly frames: ParserFrame[];
  readonly input: string;
  readonly output: string[];
  readonly rootState: { done: boolean };
  readonly start: number;
}
type ContainerRewriteContext<Frame extends ParserFrame> = RewriteContext & {
  readonly frame: Frame;
};

function markValueConsumed(
  frames: ParserFrame[],
  rootState: { done: boolean }
): void {
  const frame = frames.at(-1);
  if (frame === undefined) {
    rootState.done = true;
    return;
  }
  frame.state = "comma-or-end";
}

function pushFrame(frames: ParserFrame[], kind: ParserFrame["kind"]): void {
  if (frames.length >= K_EXAONE_2_MAX_NESTING_DEPTH) {
    throw new KExaone2SerializationError("depth");
  }
  if (kind === "array") {
    frames.push({ kind, state: "value-or-end" });
    return;
  }
  frames.push({ kind, state: "key-or-end" });
}

function rewriteValue(options: RewriteContext): number {
  const { frames, input, output, rootState, start } = options;
  markValueConsumed(frames, rootState);
  const char = input[start];

  if (char === "{") {
    output.push("{");
    pushFrame(frames, "object");
    return start + 1;
  }
  if (char === "[") {
    output.push("[");
    pushFrame(frames, "array");
    return start + 1;
  }
  if (char === '"') {
    const token = readKExaone2JsonString(input, start);
    output.push(encodeKExaone2JsonString(token.value));
    return token.end;
  }
  for (const literal of ["true", "false", "null"]) {
    if (input.startsWith(literal, start)) {
      output.push(literal);
      return start + literal.length;
    }
  }

  const number = K_EXAONE_2_JSON_NUMBER_RE.exec(input.slice(start))?.[0];
  if (number === undefined) {
    throw createKExaone2JsonSyntaxError();
  }
  output.push(JSON.stringify(`${K_EXAONE_2_HISTORY_NUMBER_PREFIX}${number}`));
  return start + number.length;
}

function rewriteObjectToken(
  options: ContainerRewriteContext<Extract<ParserFrame, { kind: "object" }>>
): number {
  const { frame, frames, input, output, rootState, start } = options;
  const char = input[start];
  if (frame.state === "key-or-end") {
    if (char === "}") {
      frames.pop();
      output.push("}");
      return start + 1;
    }
    if (char !== '"') {
      throw createKExaone2JsonSyntaxError();
    }
    const token = readKExaone2JsonString(input, start);
    output.push(
      JSON.stringify(`${K_EXAONE_2_HISTORY_KEY_PREFIX}${token.value}`)
    );
    frame.state = "colon";
    return token.end;
  }
  if (frame.state === "colon") {
    if (char !== ":") {
      throw createKExaone2JsonSyntaxError();
    }
    output.push(":");
    frame.state = "value";
    return start + 1;
  }
  if (frame.state === "value") {
    return rewriteValue({ frames, input, output, rootState, start });
  }
  if (char === ",") {
    output.push(",");
    frame.state = "key-or-end";
    return start + 1;
  }
  if (char === "}") {
    frames.pop();
    output.push("}");
    return start + 1;
  }
  throw createKExaone2JsonSyntaxError();
}

function rewriteArrayToken(
  options: ContainerRewriteContext<Extract<ParserFrame, { kind: "array" }>>
): number {
  const { frame, frames, input, output, rootState, start } = options;
  const char = input[start];
  if (frame.state === "value-or-end") {
    if (char === "]") {
      frames.pop();
      output.push("]");
      return start + 1;
    }
    return rewriteValue({ frames, input, output, rootState, start });
  }
  if (char === ",") {
    output.push(",");
    frame.state = "value-or-end";
    return start + 1;
  }
  if (char === "]") {
    frames.pop();
    output.push("]");
    return start + 1;
  }
  throw createKExaone2JsonSyntaxError();
}

function rewriteLosslessJson(input: string): string {
  const frames: ParserFrame[] = [];
  const output: string[] = [];
  const rootState = { done: false };
  let cursor = 0;
  let workItems = 0;

  while (cursor < input.length) {
    cursor = skipKExaone2JsonWhitespace(input, cursor);
    if (cursor >= input.length) {
      break;
    }
    if (rootState.done && frames.length === 0) {
      throw createKExaone2JsonSyntaxError();
    }

    const frame = frames.at(-1);
    if (frame === undefined) {
      workItems += 1;
      cursor = rewriteValue({
        frames,
        input,
        output,
        rootState,
        start: cursor,
      });
      continue;
    }

    if (frame.state === "value" || frame.state === "value-or-end") {
      workItems += 1;
    }
    if (workItems > K_EXAONE_2_MAX_SERIALIZATION_WORK_ITEMS) {
      throw new KExaone2SerializationError("size");
    }
    cursor =
      frame.kind === "object"
        ? rewriteObjectToken({
            frame,
            frames,
            input,
            output,
            rootState,
            start: cursor,
          })
        : rewriteArrayToken({
            frame,
            frames,
            input,
            output,
            rootState,
            start: cursor,
          });
  }

  if (!rootState.done || frames.length > 0) {
    throw createKExaone2JsonSyntaxError();
  }
  return output.join("");
}

export function decodeKExaone2HistoryKey(key: string): string {
  return key.startsWith(K_EXAONE_2_HISTORY_KEY_PREFIX)
    ? key.slice(K_EXAONE_2_HISTORY_KEY_PREFIX.length)
    : key;
}

export function parseKExaone2LosslessJson(input: string): KExaone2Value {
  if (input.length > K_EXAONE_2_MAX_JSON_INPUT_LENGTH) {
    throw new KExaone2SerializationError("input-size");
  }
  const rewritten = rewriteLosslessJson(input);
  const parsed = parse(rewritten, {
    duplicate: true,
    relaxed: false,
    reviver: defineReviver<KExaone2HistoryNumber>((_key, value) => {
      if (typeof value !== "string") {
        return value;
      }
      if (value.startsWith(K_EXAONE_2_HISTORY_NUMBER_PREFIX)) {
        return new KExaone2HistoryNumber(
          value.slice(K_EXAONE_2_HISTORY_NUMBER_PREFIX.length)
        );
      }
      return value.startsWith(K_EXAONE_2_HISTORY_STRING_PREFIX)
        ? value.slice(K_EXAONE_2_HISTORY_STRING_PREFIX.length)
        : value;
    }),
  });
  if (parsed === undefined) {
    throw createKExaone2JsonSyntaxError();
  }
  return parsed;
}
