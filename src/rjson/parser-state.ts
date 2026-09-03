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

import type { Token, TokenType } from "./lexer";
import type { ParseState, ParseWarning } from "./parser-types";

export function popToken(tokens: Token[], state: ParseState): Token {
  const token = tokens[state.pos];
  state.pos += 1;

  if (!token) {
    // If we are past the end of the token array, return an EOF token
    const lastLine = tokens.length === 0 ? 1 : (tokens.at(-1)?.line ?? 1);
    return { type: "eof", match: "", value: undefined, line: lastLine };
  }

  return token;
}

// Get a string representation of a token for error messages
// :: token -> string
function strToken(token: Token): string {
  switch (token.type) {
    case "atom":
    case "string":
    case "number":
      // Show type and the matched text (or value, match is usually better for context)
      return `${token.type} ${token.match}`;
    case "eof":
      return "end-of-file";
    default:
      // For punctuation, just show the symbol itself in quotes
      return `'${token.type}'`;
  }
}

// Expects and consumes a colon token, raises error/warning otherwise
// :: array token -> parseState -> undefined
export function skipColon(tokens: Token[], state: ParseState): void {
  const colon = popToken(tokens, state);
  if (colon.type !== ":") {
    const message = `Unexpected token: ${strToken(colon)}, expected ':'`;
    if (state.tolerant) {
      state.warnings.push({
        message,
        line: colon.line,
      });
      // If tolerant, put the unexpected token back by decrementing pos
      // This allows the parser to potentially recover
      state.pos -= 1;
    } else {
      const err = new SyntaxError(message);
      (err as { line?: number }).line = colon.line;
      throw err;
    }
  }
}

// Skips over any punctuation tokens until a valid data token or EOF is found.
// Used to recover in tolerant mode or find the start of the next value.
// :: array token -> parseState -> (array string)? -> token
export function skipPunctuation(
  tokens: Token[],
  state: ParseState,
  valid?: TokenType[]
): Token {
  // Define common punctuation tokens that might appear unexpectedly
  const punctuation: TokenType[] = [",", ":", "]", "}"];
  let token = popToken(tokens, state);

  while (true) {
    // If the token is one of the valid types we're looking for, return it
    if (valid?.includes(token.type)) {
      return token;
    }
    if (token.type === "eof") {
      // If we hit EOF, return it
      return token;
    }
    if (punctuation.includes(token.type)) {
      // If it's unexpected punctuation...
      const message = `Unexpected token: ${strToken(
        token
      )}, expected '[', '{', number, string or atom`;
      if (state.tolerant) {
        // In tolerant mode, record a warning and get the next token
        state.warnings.push({
          message,
          line: token.line,
        });
        token = popToken(tokens, state); // Continue skipping
      } else {
        // In strict mode, throw an error
        const err = new SyntaxError(message);
        (err as { line?: number }).line = token.line;
        throw err;
      }
    } else {
      // If it's not punctuation, EOF, or a specifically valid token,
      // it must be the start of a value/object/array, so return it.
      return token;
    }
  }
}

// Helper to raise an error or add a warning based on tolerant mode
// :: parseState -> token -> string -> undefined
export function raiseError(
  state: ParseState,
  token: Token,
  message: string
): void {
  if (state.tolerant) {
    state.warnings.push({
      message,
      line: token.line,
    });
  } else {
    const err = new SyntaxError(message);
    (err as { line?: number }).line = token.line;
    throw err;
  }
}

// Helper for common "Unexpected token X, expected Y" errors
// :: parseState -> token -> string -> undefined
export function raiseUnexpected(
  state: ParseState,
  token: Token,
  expected: string
): void {
  raiseError(
    state,
    token,
    `Unexpected token: ${strToken(token)}, expected ${expected}`
  );
}

// Checks for duplicate keys in objects when duplicate checking is enabled (state.duplicate = false).
// If a duplicate key is found, raises an error (respecting tolerant mode).
// This enforces JSON specification compliance for duplicate key handling.
// :: parseState -> {} -> parseToken -> undefined
export function checkDuplicates(
  state: ParseState,
  obj: { [key: string]: unknown },
  token: Token
): void {
  // We assume token.type is 'string' here based on where it's called in parsePair
  // If other types could be keys, this check needs adjustment.
  const key = String(token.value); // Ensure key is string for lookup

  // Only check for duplicates when duplicate checking is enabled
  // state.duplicate = false means "reject duplicates", so we check when !state.duplicate
  if (!state.duplicate && Object.hasOwn(obj, key)) {
    raiseError(state, token, `Duplicate key: ${key}`);
    // Note: In tolerant mode, this adds a warning and continues parsing.
    // In strict mode, this throws immediately. Either way, last value wins for the duplicate key.
  }
}

function defineObjectProperty(
  obj: Record<string, unknown>,
  propertyKey: string,
  value: unknown
): void {
  Object.defineProperty(obj, propertyKey, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

// Appends a key-value pair to an object, applying the reviver function if present
// :: parseState -> any -> any -> any -> undefined
export function appendPair(
  state: ParseState,
  obj: { [objKey: string]: unknown },
  key: string,
  value: unknown
): void {
  // Apply reviver function if it exists
  const finalValue = state.reviver ? state.reviver(key, value) : value;
  // The reviver can return undefined to omit the key/value pair
  if (finalValue !== undefined) {
    defineObjectProperty(obj, key, finalValue);
  }
}

// Parses a key-value pair within an object
// :: array parseToken -> parseState -> map -> undefined
export function endChecks(
  tokens: Token[],
  state: ParseState,
  ret: unknown
): void {
  // Check if there are unparsed tokens remaining
  if (state.pos < tokens.length) {
    // In tolerant mode, skip trailing whitespace/punctuation before declaring error
    if (state.tolerant) {
      skipPunctuation(tokens, state); // Try skipping junk
    }
    // If still not at the end, raise error/warning
    if (state.pos < tokens.length) {
      raiseError(
        state,
        tokens[state.pos],
        `Unexpected token: ${strToken(tokens[state.pos])}, expected end-of-input`
      );
    }
  }

  // If in tolerant mode and warnings were generated, throw a summary error at the end
  if (state.tolerant && state.warnings.length > 0) {
    const message =
      state.warnings.length === 1
        ? state.warnings[0].message // Single warning message
        : `${state.warnings.length} parse warnings`; // Multiple warnings summary
    const err = new SyntaxError(message);
    // Attach details to the error object
    (err as { line?: number; warnings?: ParseWarning[]; obj?: unknown }).line =
      state.warnings[0].line; // Line of the first warning
    (
      err as { line?: number; warnings?: ParseWarning[]; obj?: unknown }
    ).warnings = state.warnings; // Array of all warnings
    (err as { line?: number; warnings?: ParseWarning[]; obj?: unknown }).obj =
      ret; // The partially parsed object (might be useful)
    throw err;
  }
}

// Main recursive parsing function for any JSON value type
// :: array parseToken -> parseState -> boolean? -> any
