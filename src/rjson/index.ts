/*
  Copyright (c) 2013, Oleg Grenrus
  All rights reserved.

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:
      * Redistributions of source code must retain the above copyright
        notice, this list of conditions and the following disclaimer.
      * Redistributions in binary form must reproduce the above copyright
        notice, this list of conditions and the following disclaimer in the
        documentation and/or other materials provided with the distribution.
      * Neither the name of the Oleg Grenrus nor the
        names of its contributors may be used to endorse or promote products
        derived from this software without specific prior written permission.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
  ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
  DISCLAIMED. IN NO EVENT SHALL OLEG GRENRUS BE LIABLE FOR ANY WAY OUT OF THE USE
  OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

/*
  https://github.com/phadej/relaxed-json
  TypeScript porting based on the original code.
  Follows the license of the original code.
*/

import {
  lexer,
  strictLexer,
  stripTrailingComma,
  type Token,
  transform as transformRelaxedJson,
} from "./lexer";
import {
  appendPair,
  checkDuplicates,
  endChecks,
  type ParseOptions,
  type ParseState,
  parseMany,
  raiseUnexpected,
  skipColon,
  skipPunctuation,
} from "./parser-helpers";
import { stringify as stringifyValue } from "./stringify";

function parsePair(
  tokens: Token[],
  state: ParseState,
  obj: { [key: string]: unknown }
): void {
  let token = skipPunctuation(tokens, state, [":", "string", "number", "atom"]);
  let value: unknown;

  if (token.type !== "string") {
    raiseUnexpected(state, token, "string key");

    if (state.tolerant) {
      switch (token.type) {
        case ":":
          token = {
            type: "string",
            value: "null",
            match: '"null"',
            line: token.line,
          };
          state.pos -= 1;
          break;
        case "number":
        case "atom":
          token = {
            type: "string",
            value: String(token.value),
            match: `"${token.value}"`,
            line: token.line,
          };
          break;
        case "[":
        case "{":
          state.pos -= 1;
          value = parseAny(tokens, state);
          checkDuplicates(state, obj, {
            type: "string",
            value: "null",
            match: '"null"',
            line: token.line,
          });
          appendPair(state, obj, "null", value);
          return;
        case "eof":
          return;
        default:
          return;
      }
    } else {
      return;
    }
  }

  checkDuplicates(state, obj, token);
  const key = String(token.value);

  skipColon(tokens, state);
  value = parseAny(tokens, state);
  appendPair(state, obj, key, value);
}

function parseElement(
  tokens: Token[],
  state: ParseState,
  arr: unknown[]
): void {
  const key = arr.length;
  const value = parseAny(tokens, state);
  arr[key] = state.reviver ? state.reviver(String(key), value) : value;
}

function parseObject(
  tokens: Token[],
  state: ParseState
): { [key: string]: unknown } {
  const obj = {};
  return parseMany<{ [key: string]: unknown }>(tokens, state, obj, {
    skip: [":", "}"],
    elementParser: parsePair,
    elementName: "string key",
    endSymbol: "}",
  });
}

function parseArray(tokens: Token[], state: ParseState): unknown[] {
  const arr: unknown[] = [];
  return parseMany<unknown[]>(tokens, state, arr, {
    skip: ["]"],
    elementParser: parseElement,
    elementName: "json value",
    endSymbol: "]",
  });
}

function parseAny(tokens: Token[], state: ParseState, end = false): unknown {
  const token = skipPunctuation(tokens, state);
  let ret: unknown;

  if (token.type === "eof") {
    if (end) {
      raiseUnexpected(state, token, "json value");
    }
    raiseUnexpected(state, token, "json value");
    return;
  }

  switch (token.type) {
    case "{":
      ret = parseObject(tokens, state);
      break;
    case "[":
      ret = parseArray(tokens, state);
      break;
    case "string":
    case "number":
    case "atom":
      ret = token.value;
      break;
    default:
      raiseUnexpected(state, token, "json value");
      if (state.tolerant) {
        ret = null;
      } else {
        return;
      }
  }

  if (end) {
    ret = state.reviver ? state.reviver("", ret) : ret;
    endChecks(tokens, state, ret);
  }

  return ret;
}

function normalizeParseOptions(
  optsOrReviver?: ParseOptions | ((key: string, value: unknown) => unknown)
): ParseOptions {
  let options: ParseOptions = {};

  if (typeof optsOrReviver === "function") {
    options.reviver = optsOrReviver;
  } else if (optsOrReviver !== null && typeof optsOrReviver === "object") {
    options = { ...optsOrReviver };
  } else if (optsOrReviver !== undefined) {
    throw new TypeError(
      "Second argument must be a reviver function or an options object."
    );
  }

  if (options.relaxed === undefined) {
    if (options.warnings === true || options.tolerant === true) {
      options.relaxed = true;
    } else if (options.warnings === false && options.tolerant === false) {
      options.relaxed = false;
    } else {
      options.relaxed = true;
    }
  }

  options.tolerant = options.tolerant || options.warnings;
  options.duplicate = options.duplicate ?? false;

  return options;
}

function createParseState(options: ParseOptions): ParseState {
  return {
    pos: 0,
    reviver: options.reviver,
    tolerant: options.tolerant ?? false,
    duplicate: options.duplicate ?? false,
    warnings: [],
  };
}

function parseWithCustomParser(text: string, options: ParseOptions): unknown {
  const lexerToUse = options.relaxed ? lexer : strictLexer;
  let tokens = lexerToUse(text);

  if (options.relaxed) {
    tokens = stripTrailingComma(tokens);
  }

  tokens = tokens.filter((token) => token.type !== " ");
  const state = createParseState(options);
  return parseAny(tokens, state, true);
}

function parseWithTransform(text: string, options: ParseOptions): unknown {
  let tokens = lexer(text);
  tokens = stripTrailingComma(tokens);
  const newtext = tokens.reduce((str, token) => str + token.match, "");
  return JSON.parse(
    newtext,
    options.reviver as (key: string, value: unknown) => unknown
  );
}

/**
 * Parse a JSON string with enhanced features beyond standard JSON.parse().
 */
function parse(
  text: string,
  optsOrReviver?: ParseOptions | ((key: string, value: unknown) => unknown)
): unknown {
  const options = normalizeParseOptions(optsOrReviver);

  if (
    !(options.relaxed || options.warnings || options.tolerant) &&
    options.duplicate
  ) {
    return JSON.parse(
      text,
      options.reviver as (key: string, value: unknown) => unknown
    );
  }

  if (options.warnings || options.tolerant || !options.duplicate) {
    return parseWithCustomParser(text, options);
  }

  return parseWithTransform(text, options);
}

function transform(text: string): string {
  return transformRelaxedJson(text);
}

function stringify(value: unknown): string {
  return stringifyValue(value);
}

export type { ParseOptions } from "./parser-helpers";
export { parse, stringify, transform };
