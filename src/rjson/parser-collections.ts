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
  DISCLAIMED. IN NO EVENT SHALL OLEG GRENRUS BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
  SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

/*
  https://github.com/phadej/relaxed-json
  TypeScript porting based on the original code.
  Follows the license of the original code.
*/

import type { JSONArray, JSONObject, JSONValue } from "@ai-sdk/provider";

import type { Token } from "./lexer";
import {
  appendPair,
  checkDuplicates,
  hasValue,
  popToken,
  raiseError,
  raiseUnexpected,
  skipColon,
  skipPunctuation,
} from "./parser-state";
import type { ParseManyOpts, ParseState } from "./parser-types";
import { parseAny } from "./parser-value";

function parsePair(tokens: Token[], state: ParseState, obj: JSONObject): void {
  // Skip leading punctuation, expecting a string key (or ':' in tolerant mode)
  let token = skipPunctuation(tokens, state, [":", "string", "number", "atom"]); // Allow recovery
  let value: JSONValue | undefined;

  // --- Key Parsing ---
  if (token.type !== "string") {
    // Handle unexpected token where a string key was expected
    raiseUnexpected(state, token, "string key");

    // Attempt recovery in tolerant mode
    if (state.tolerant) {
      switch (token.type) {
        case ":": // If colon found directly, assume missing key, use "null"
          token = {
            type: "string",
            value: "null",
            match: '"null"',
            line: token.line,
          };
          state.pos -= 1; // Put the colon back for skipColon
          break;
        case "number": // Use number as string key
        case "atom": // Use atom value as string key
          token = {
            type: "string",
            value: String(token.value),
            match: `"${token.value}"`,
            line: token.line,
          };
          break;
        case "[": // Assume missing key before an array
        case "{": // Assume missing key before an object
          state.pos -= 1; // Put back the bracket/brace
          value = parseAny(tokens, state); // Parse the value directly
          checkDuplicates(state, obj, {
            type: "string",
            value: "null",
            match: '"null"',
            line: token.line,
          }); // Check duplicate for "null" key
          appendPair(obj, "null", value); // Append with "null" key
          return; // Finished parsing this "pair"
        case "eof": // Reached end unexpectedly
          return; // Cannot recover
        default: // Other unexpected token (like comma, closing brace)
          // raiseUnexpected already issued a warning/error. Try to advance.
          // This might lead to cascading errors, but it's tolerant mode.
          return;
      }
    } else {
      // In non-tolerant mode, raiseUnexpected already threw.
      return; // Should be unreachable
    }
  }

  // Now we have a string token (potentially recovered)
  checkDuplicates(state, obj, token);
  const key = String(token.value); // Ensure key is string

  // --- Colon and Value Parsing ---
  skipColon(tokens, state); // Expect and consume ':'
  value = parseAny(tokens, state); // Parse the value recursively

  // --- Appending Pair ---
  appendPair(obj, key, value);
}

// Parses an element within an array
// :: array parseToken -> parseState -> array -> undefined
function parseElement(
  tokens: Token[],
  state: ParseState,
  arr: JSONArray
): void {
  const key = arr.length; // Key is the current array index
  // Skip potential leading punctuation (like extra commas in tolerant mode)
  // skipPunctuation used inside parseAny handles this implicitly
  const value = parseAny(tokens, state); // Recursively parse the element value
  if (!hasValue(value)) {
    arr.length += 1;
    return;
  }
  arr[key] = value;
}

// Parses a JSON object structure: '{' key:value, ... '}'
// :: array parseToken -> parseState -> {}
export function parseObject(tokens: Token[], state: ParseState): JSONObject {
  const obj: JSONObject = {};
  // Call parseMany to handle the structure { pair1, pair2, ... }
  return parseMany(tokens, state, obj, {
    skip: [":", "}"], // Initially skip over colon or closing brace (for empty/tolerant cases)
    elementParser: parsePair, // Use parsePair to parse each key-value element
    elementName: "string key", // Expected element type for errors
    endSymbol: "}", // The closing token for an object
  });
}

// Parses a JSON array structure: '[' element, ... ']'
// :: array parseToken -> parseState -> array
export function parseArray(tokens: Token[], state: ParseState): JSONArray {
  const arr: JSONArray = [];
  // Call parseMany to handle the structure [ element1, element2, ... ]
  return parseMany(tokens, state, arr, {
    skip: ["]"], // Initially skip over closing bracket (for empty/tolerant cases)
    elementParser: parseElement, // Use parseElement to parse each array item
    elementName: "json value", // Expected element type for errors
    endSymbol: "]", // The closing token for an array
  });
}

// Helper to handle comma tokens in parseMany
interface HandleCommaTokenParams<T> {
  readonly opts: ParseManyOpts<T>;
  readonly result: T;
  readonly state: ParseState;
  readonly token: Token;
  readonly tokens: Token[];
}

function handleCommaToken<T>(params: HandleCommaTokenParams<T>): T | null {
  const { token, tokens, state, opts, result } = params;
  const nextToken = tokens[state.pos];
  if (state.tolerant && nextToken && nextToken.type === opts.endSymbol) {
    raiseError(state, token, `Trailing comma before '${opts.endSymbol}'`);
    popToken(tokens, state);
    return result;
  }
  opts.elementParser(tokens, state, result);
  return null; // Signal to continue parsing
}

// Helper to handle the initial element in parseMany
function parseManyInitialElement<T>(
  tokens: Token[],
  state: ParseState,
  result: T,
  opts: ParseManyOpts<T>
): T | undefined {
  const token = skipPunctuation(tokens, state, opts.skip);

  if (token.type === "eof") {
    raiseUnexpected(state, token, `'${opts.endSymbol}' or ${opts.elementName}`);
    return result;
  }

  if (token.type === opts.endSymbol) {
    return result;
  }

  state.pos -= 1;
  opts.elementParser(tokens, state, result);
}

// Helper to process a token in parseMany loop
function parseManyProcessToken<T>(params: {
  readonly token: Token;
  readonly tokens: Token[];
  readonly state: ParseState;
  readonly opts: ParseManyOpts<T>;
  readonly result: T;
}): T | undefined {
  const { token, tokens, state, opts, result } = params;
  if (token.type !== opts.endSymbol && token.type !== ",") {
    raiseUnexpected(state, token, `',' or '${opts.endSymbol}'`);
    if (token.type === "eof") {
      return result;
    }
    // Tolerant mode assumes a comma was missing and retries this token.
    state.pos -= 1;
  }

  if (token.type === opts.endSymbol) {
    return result;
  }

  if (token.type === ",") {
    const handledResult = handleCommaToken({
      token,
      tokens,
      state,
      opts,
      result,
    });
    if (handledResult !== null) {
      return handledResult;
    }
    return; // Continue loop
  }

  opts.elementParser(tokens, state, result);
}

// Generic function to parse comma-separated elements within enclosing symbols (like objects or arrays)
// :: t : array | {} => array parseToken -> parseState -> t -> parseManyOpts -> t
function parseMany<T>(
  tokens: Token[],
  state: ParseState,
  result: T,
  opts: ParseManyOpts<T>
): T {
  const initialResult = parseManyInitialElement(tokens, state, result, opts);
  if (initialResult !== undefined) {
    return initialResult;
  }

  while (true) {
    const token = popToken(tokens, state);
    const processedResult = parseManyProcessToken({
      token,
      tokens,
      state,
      opts,
      result,
    });
    if (processedResult !== undefined) {
      return processedResult;
    }
  }
}

// Perform final checks after parsing the main value
// :: array parseToken -> parseState -> any -> undefined
