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

import {
  lexer,
  strictLexer,
  stripTrailingComma,
  type Token,
  type TokenType,
  transform as transformRelaxedJson,
} from "./lexer";
import { stringify as stringifyValue } from "./stringify";

// Type for parse warnings
interface ParseWarning {
  line: number;
  message: string;
}

// Type for the state object used during parsing
interface ParseState {
  duplicate: boolean; // true = allow duplicate keys (use last value), false = reject duplicate keys with error
  pos: number; // Current position in the token array
  reviver?: (key: string, value: unknown) => unknown; // Optional JSON reviver function
  // Options passed to the parser
  tolerant: boolean;
  warnings: ParseWarning[];
}

/**
 * Options for configuring JSON parsing behavior
 */
interface ParseOptions {
  /**
   * Allow duplicate object keys in JSON.
   * - true: Allow duplicates (uses last value, like native JSON.parse)
   * - false: Reject duplicates with error (enforces JSON specification)
   * @default false
   */
  duplicate?: boolean;
  /**
   * Enable relaxed JSON syntax parsing (unquoted keys, single quotes, trailing commas, comments)
   * @default true
   */
  relaxed?: boolean;

  /**
   * Optional reviver function to transform parsed values (same as JSON.parse reviver)
   * @param key - The object key or array index
   * @param value - The parsed value
   * @returns The transformed value
   */
  reviver?: (key: string, value: unknown) => unknown;

  /**
   * Continue parsing when encountering recoverable errors, collecting warnings.
   * In strict mode (false), throws immediately on first error.
   * @default false
   */
  tolerant?: boolean;

  /**
   * Collect parsing warnings instead of throwing immediately. Implies tolerant mode.
   * At the end of parsing, if warnings exist, throws with warning details.
   * @default false
   */
  warnings?: boolean;
}

// Type for options specific to the parseMany function
interface ParseManyOpts<T> {
  elementName: string; // Name of the expected element for error messages
  elementParser: (tokens: Token[], state: ParseState, obj: T) => void; // Function to parse an element/pair
  endSymbol: TokenType; // The token type that marks the end of the structure (']' or '}')
  skip: TokenType[]; // Token types to skip initially
}

// --- Parser Helper Functions ---

function popToken(tokens: Token[], state: ParseState): Token {
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
function skipColon(tokens: Token[], state: ParseState): void {
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
function skipPunctuation(
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
function raiseError(state: ParseState, token: Token, message: string): void {
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
function raiseUnexpected(
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
function checkDuplicates(
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
function appendPair(
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
function parsePair(
  tokens: Token[],
  state: ParseState,
  obj: { [key: string]: unknown }
): void {
  // Skip leading punctuation, expecting a string key (or ':' in tolerant mode)
  let token = skipPunctuation(tokens, state, [":", "string", "number", "atom"]); // Allow recovery
  let value: unknown;

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
          appendPair(state, obj, "null", value); // Append with "null" key
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
  appendPair(state, obj, key, value);
}

// Parses an element within an array
// :: array parseToken -> parseState -> array -> undefined
function parseElement(
  tokens: Token[],
  state: ParseState,
  arr: unknown[]
): void {
  const key = arr.length; // Key is the current array index
  // Skip potential leading punctuation (like extra commas in tolerant mode)
  // skipPunctuation used inside parseAny handles this implicitly
  const value = parseAny(tokens, state); // Recursively parse the element value
  // Apply reviver using the index as a string key
  arr[key] = state.reviver ? state.reviver(String(key), value) : value;
}

// Parses a JSON object structure: '{' key:value, ... '}'
// :: array parseToken -> parseState -> {}
function parseObject(
  tokens: Token[],
  state: ParseState
): { [key: string]: unknown } {
  const obj = {};
  // Call parseMany to handle the structure { pair1, pair2, ... }
  return parseMany<{ [key: string]: unknown }>(tokens, state, obj, {
    skip: [":", "}"], // Initially skip over colon or closing brace (for empty/tolerant cases)
    elementParser: parsePair, // Use parsePair to parse each key-value element
    elementName: "string key", // Expected element type for errors
    endSymbol: "}", // The closing token for an object
  });
}

// Parses a JSON array structure: '[' element, ... ']'
// :: array parseToken -> parseState -> array
function parseArray(tokens: Token[], state: ParseState): unknown[] {
  const arr: unknown[] = [];
  // Call parseMany to handle the structure [ element1, element2, ... ]
  return parseMany<unknown[]>(tokens, state, arr, {
    skip: ["]"], // Initially skip over closing bracket (for empty/tolerant cases)
    elementParser: parseElement, // Use parseElement to parse each array item
    elementName: "json value", // Expected element type for errors
    endSymbol: "]", // The closing token for an array
  });
}

// Helper to handle invalid tokens in parseMany
function handleInvalidToken<T>(
  token: Token,
  state: ParseState,
  opts: ParseManyOpts<T>,
  result: T
): T | null {
  raiseUnexpected(state, token, `',' or '${opts.endSymbol}'`);

  if (state.tolerant) {
    if (token.type === "eof") {
      return result;
    }
    // Assume a comma was missing and put the token back
    state.pos -= 1;
    return null; // Signal to continue parsing
  }
  return result; // Should be unreachable in strict mode
}

// Helper to handle comma tokens in parseMany
interface HandleCommaTokenParams<T> {
  opts: ParseManyOpts<T>;
  result: T;
  state: ParseState;
  token: Token;
  tokens: Token[];
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
  token: Token;
  tokens: Token[];
  state: ParseState;
  opts: ParseManyOpts<T>;
  result: T;
}): T | undefined {
  const { token, tokens, state, opts, result } = params;
  if (token.type !== opts.endSymbol && token.type !== ",") {
    const handledResult = handleInvalidToken(token, state, opts, result);
    if (handledResult !== null) {
      return handledResult;
    }
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
function endChecks(tokens: Token[], state: ParseState, ret: unknown): void {
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
function parseAny(tokens: Token[], state: ParseState, end = false): unknown {
  // Skip any leading punctuation (useful for recovery in tolerant mode)
  const token = skipPunctuation(tokens, state);
  let ret: unknown; // Variable to hold the parsed result

  // Check for premature end of file
  if (token.type === "eof") {
    // Only raise error if we expected a value (not called recursively within a structure)
    // If 'end' is true, we are at the top level.
    if (end) {
      raiseUnexpected(state, token, "json value");
    }
    // If called recursively (e.g., after a comma), returning undefined might be handled
    // by the caller (like parseElement/parsePair). However, hitting EOF here usually
    // means an incomplete structure. Let's raise an error/warning.
    raiseUnexpected(state, token, "json value");
    return; // Return undefined in tolerant mode after warning
  }

  // Parse based on the token type
  switch (token.type) {
    case "{": // Start of an object
      ret = parseObject(tokens, state);
      break;
    case "[": // Start of an array
      ret = parseArray(tokens, state);
      break;
    case "string": // String literal
    case "number": // Number literal
    case "atom": // Keyword literal (true, false, null)
      ret = token.value;
      break;
    default:
      // Unexpected token type to start a value
      raiseUnexpected(state, token, "json value");
      // Attempt recovery in tolerant mode by returning null
      if (state.tolerant) {
        ret = null;
      } else {
        // Error already thrown
        return; // Should be unreachable
      }
  }

  // If this is the top-level call (end === true)
  if (end) {
    // Apply the top-level reviver function (key is empty string)
    ret = state.reviver ? state.reviver("", ret) : ret;
    // Perform final checks for trailing tokens or accumulated warnings
    endChecks(tokens, state, ret);
  }

  return ret;
}

// Helper to normalize parse options
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

  // Set default for relaxed mode
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

// Helper to create parser state
function createParseState(options: ParseOptions): ParseState {
  return {
    pos: 0,
    reviver: options.reviver,
    tolerant: options.tolerant ?? false,
    duplicate: options.duplicate ?? false,
    warnings: [],
  };
}

// Helper to use custom parser with tokens
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

// Helper to use native JSON.parse with transformation
function parseWithTransform(text: string, options: ParseOptions): unknown {
  let tokens = lexer(text);
  tokens = stripTrailingComma(tokens);
  const newtext = tokens.reduce((str, token) => str + token.match, "");
  return JSON.parse(
    newtext,
    options.reviver as (key: string, value: unknown) => unknown
  );
}

// --- Main Parse Function ---

/**
 * Parse a JSON string with enhanced features beyond standard JSON.parse()
 *
 * Supports both strict JSON and relaxed JSON syntax with configurable error handling
 * and duplicate key validation.
 *
 * @param text - The JSON string to parse
 * @param optsOrReviver - Either a ParseOptions object for configuration, or a reviver function (like JSON.parse)
 *
 * @returns The parsed JavaScript value
 *
 * @throws {SyntaxError} When parsing fails in strict mode, or when warnings are collected in tolerant mode
 *
 * @example
 * ```typescript
 * // Standard JSON parsing
 * parse('{"key": "value"}')
 *
 * // Relaxed JSON with unquoted keys and trailing commas
 * parse('{key: "value", trailing: "comma",}', { relaxed: true })
 *
 * // Strict duplicate key validation
 * parse('{"key": 1, "key": 2}', { duplicate: false }) // throws error
 *
 * // Allow duplicates (uses last value)
 * parse('{"key": 1, "key": 2}', { duplicate: true }) // returns {key: 2}
 *
 * // Tolerant mode with warning collection
 * parse('malformed json', { tolerant: true, warnings: true })
 * ```
 */
function parse(
  text: string,
  optsOrReviver?: ParseOptions | ((key: string, value: unknown) => unknown)
): unknown {
  const options = normalizeParseOptions(optsOrReviver);

  // Strategy 1: Strict JSON with duplicate allowance -> use native JSON.parse
  if (
    !(options.relaxed || options.warnings || options.tolerant) &&
    options.duplicate
  ) {
    return JSON.parse(
      text,
      options.reviver as (key: string, value: unknown) => unknown
    );
  }

  // Strategy 2: Need custom parser (warnings, tolerant, or duplicate checking)
  if (options.warnings || options.tolerant || !options.duplicate) {
    return parseWithCustomParser(text, options);
  }

  // Strategy 3: Relaxed syntax without warnings/tolerance -> transform and use native
  return parseWithTransform(text, options);
}

function transform(text: string): string {
  return transformRelaxedJson(text);
}

function stringify(value: unknown): string {
  return stringifyValue(value);
}

export type { ParseOptions };
export { parse, stringify, transform };
