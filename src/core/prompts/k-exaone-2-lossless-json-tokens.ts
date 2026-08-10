export const K_EXAONE_2_HISTORY_KEY_PREFIX = "\u0000kexaone:key:";
export const K_EXAONE_2_HISTORY_NUMBER_PREFIX = "\u0000kexaone:number:";
export const K_EXAONE_2_HISTORY_STRING_PREFIX = "\u0000kexaone:string:";
export const K_EXAONE_2_JSON_NUMBER_RE =
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

const JSON_WHITESPACE_RE = /\s/;

export interface KExaone2HistoryNumber {
  readonly raw: string;
  readonly type: "k-exaone-history-number";
}

export function createKExaone2JsonSyntaxError(): SyntaxError {
  return new SyntaxError("Invalid K-EXAONE tool-call JSON");
}

export function skipKExaone2JsonWhitespace(
  input: string,
  cursor: number
): number {
  let index = cursor;
  while (index < input.length && JSON_WHITESPACE_RE.test(input[index] ?? "")) {
    index += 1;
  }
  return index;
}

export function readKExaone2JsonString(
  input: string,
  cursor: number
): { readonly end: number; readonly value: string } {
  let escaping = false;
  for (let index = cursor + 1; index < input.length; index += 1) {
    const char = input[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === '"') {
      const token = input.slice(cursor, index + 1);
      const value: unknown = JSON.parse(token);
      if (typeof value !== "string") {
        throw createKExaone2JsonSyntaxError();
      }
      return { end: index + 1, value };
    }
  }
  throw createKExaone2JsonSyntaxError();
}

export function encodeKExaone2JsonString(value: string): string {
  return JSON.stringify(`${K_EXAONE_2_HISTORY_STRING_PREFIX}${value}`);
}
