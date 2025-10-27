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

// --- Regex Constants (for performance) ---
const WHITESPACE_TEST_REGEX = /\s/;
const WHITESPACE_REGEX = /^\s+/;
const OBJECT_START_REGEX = /^\{/;
const OBJECT_END_REGEX = /^\}/;
const ARRAY_START_REGEX = /^\[/;
const ARRAY_END_REGEX = /^\]/;
const COMMA_REGEX = /^,/;
const COLON_REGEX = /^:/;
const KEYWORD_REGEX = /^(?:true|false|null)/;
const NUMBER_REGEX = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const STRING_DOUBLE_REGEX = /^"(?:[^"\\]|\\["bnrtf\\/]|\\u[0-9a-fA-F]{4})*"/;
const STRING_SINGLE_REGEX = /^'((?:[^'\\]|\\['bnrtf\\/]|\\u[0-9a-fA-F]{4})*)'/;
const COMMENT_SINGLE_REGEX = /^\/\/.*?(?:\r\n|\r|\n)/;
const COMMENT_MULTI_REGEX = /^\/\*[\s\S]*?\*\//;
const IDENTIFIER_REGEX = /^[$a-zA-Z0-9_\-+.*?!|&%^/#\\]+/;

// Custom 'some' function definition (slightly different from ES5, returns the truthy value directly)
// :: array -> fn -> *
function some<T, R>(
  array: T[],
  f: (item: T, index: number, arr: T[]) => R | undefined | false
): R | false {
  let acc: R | false = false;
  for (let i = 0; i < array.length; i++) {
    // We assume R is a truthy type if the condition is met, or undefined/false otherwise.
    const result = f(array[i], i, array);
    acc = result === undefined ? false : result;
    if (acc) {
      return acc; // Return the actual truthy value found
    }
  }
  return acc; // Returns false if no truthy value was returned by f
}

// --- Type Definitions ---

// Type for the specification of a single token type
type TokenSpec = {
  re: RegExp;
  // Function to process the regex match and return a RawToken
  f: (match: RegExpExecArray) => RawToken;
};

// Literal types for possible token types
type TokenType =
  | "atom" // null, true, false
  | "number"
  | "string"
  | "["
  | "]"
  | "{"
  | "}"
  | ":"
  | ","
  | " " // Whitespace / Comments
  | "eof"; // End of file

// Type for a token right after regex matching, before line number is added
// Value is optional as punctuation/whitespace tokens might not have a semantic value
type RawToken = {
  type: TokenType;
  match: string; // The raw matched text
  value?: unknown; // The parsed value (for strings, numbers, atoms)
};

// Type for a token including line number information
type Token = RawToken & {
  line: number;
};

// Type for parse warnings
type ParseWarning = {
  message: string;
  line: number;
};

// Type for the state object used during parsing
type ParseState = {
  pos: number; // Current position in the token array
  warnings: ParseWarning[];
  // Options passed to the parser
  tolerant: boolean;
  duplicate: boolean; // true = allow duplicate keys (use last value), false = reject duplicate keys with error
  reviver?: (key: string, value: unknown) => unknown; // Optional JSON reviver function
};

/**
 * Options for configuring JSON parsing behavior
 */
type ParseOptions = {
  /**
   * Enable relaxed JSON syntax parsing (unquoted keys, single quotes, trailing commas, comments)
   * @default true
   */
  relaxed?: boolean;

  /**
   * Collect parsing warnings instead of throwing immediately. Implies tolerant mode.
   * At the end of parsing, if warnings exist, throws with warning details.
   * @default false
   */
  warnings?: boolean;

  /**
   * Continue parsing when encountering recoverable errors, collecting warnings.
   * In strict mode (false), throws immediately on first error.
   * @default false
   */
  tolerant?: boolean;

  /**
   * Allow duplicate object keys in JSON.
   * - true: Allow duplicates (uses last value, like native JSON.parse)
   * - false: Reject duplicates with error (enforces JSON specification)
   * @default false
   */
  duplicate?: boolean;

  /**
   * Optional reviver function to transform parsed values (same as JSON.parse reviver)
   * @param key - The object key or array index
   * @param value - The parsed value
   * @returns The transformed value
   */
  reviver?: (key: string, value: unknown) => unknown;
};

// Type for options specific to the parseMany function
type ParseManyOpts<T> = {
  skip: TokenType[]; // Token types to skip initially
  elementParser: (tokens: Token[], state: ParseState, obj: T) => void; // Function to parse an element/pair
  elementName: string; // Name of the expected element for error messages
  endSymbol: TokenType; // The token type that marks the end of the structure (']' or '}')
};

// --- Lexer Implementation ---

// Factory function to create a lexer
// :: array tokenSpec -> fn
function makeLexer(tokenSpecs: TokenSpec[]): (contents: string) => Token[] {
  // The returned lexer function
  // :: string -> array token
  return (contents: string): Token[] => {
    const tokens: Token[] = [];
    let line = 1; // Start at line 1

    // Helper function to find the next token in the input string
    // :: -> { raw: string, matched: RawToken } | undefined
    function findToken(): { raw: string; matched: RawToken } | undefined {
      // Use the custom 'some' function to iterate through token specifications
      const result = some(tokenSpecs, (tokenSpec) => {
        const m = tokenSpec.re.exec(contents); // Try to match the regex at the current position
        if (m) {
          const raw = m[0]; // The matched raw string
          contents = contents.slice(raw.length); // Consume the matched part from the input
          return {
            raw,
            matched: tokenSpec.f(m), // Process the match using the spec's function
          };
        }
        return; // No match for this spec
      });
      return result === false ? undefined : result;
    }

    // Main lexing loop
    while (contents !== "") {
      const matched = findToken(); // Find the next token

      if (!matched) {
        // If no token spec matches, it's a syntax error
        const err = new SyntaxError(
          `Unexpected character: ${contents[0]}; input: ${contents.substr(
            0,
            100
          )}`
        );
        // Attach line number to the error object (standard Error doesn't have it by default)
        (err as { line?: number }).line = line;
        throw err;
      }

      // Add line number information to the matched token
      // We need type assertion because 'matched.matched' is initially RawToken
      const tokenWithLine = matched.matched as Token;
      tokenWithLine.line = line;

      // Update line number count based on newlines in the matched raw string
      line += matched.raw.replace(/[^\n]/g, "").length;

      tokens.push(tokenWithLine); // Add the finalized token to the list
    }

    // Add an EOF token (useful for the parser) - Optional, depends on parser needs.
    // The current parser handles end-of-input via state.pos check, so EOF token isn't strictly needed here
    // tokens.push({ type: 'eof', match: '', value: undefined, line: line });

    return tokens;
  };
}

// --- Token Creation Helper Functions ---

// :: tuple string string -> rawToken
function fStringSingle(m: RegExpExecArray): RawToken {
  // Handles strings in single quotes, converting them to standard JSON double-quoted strings
  const content = m[1].replace(
    /([^'\\]|\\['bnrtf\\]|\\u[0-9a-fA-F]{4})/g,
    (mm) => {
      if (mm === '"') {
        return '\\"'; // Escape double quotes inside
      }
      if (mm === "\\'") {
        return "'"; // Unescape escaped single quotes
      }
      return mm;
    }
  );

  const match = `"${content}"`;
  return {
    type: "string",
    match, // The transformed, double-quoted string representation
    // Use JSON.parse on the transformed string to handle escape sequences correctly
    value: JSON.parse(match),
  };
}

// :: tuple string -> rawToken
function fStringDouble(m: RegExpExecArray): RawToken {
  // Handles standard JSON double-quoted strings
  return {
    type: "string",
    match: m[0], // The raw matched string (including quotes)
    value: JSON.parse(m[0]), // Use JSON.parse to handle escapes and get the value
  };
}

// :: tuple string -> rawToken
function fIdentifier(m: RegExpExecArray): RawToken {
  // Transforms unquoted identifiers into JSON strings
  const value = m[0];
  const match =
    '"' +
    value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + // Escape backslashes and quotes
    '"';
  return {
    type: "string", // Treat identifiers as strings
    value, // The original identifier name
    match, // The double-quoted string representation
  };
}

// :: tuple string -> rawToken
function fComment(m: RegExpExecArray): RawToken {
  // Treats comments as whitespace, preserving only newlines
  const match = m[0].replace(/./g, (c) => (WHITESPACE_TEST_REGEX.test(c) ? c : " "));
  return {
    type: " ", // Represent comments as whitespace tokens
    match, // String containing original newlines and spaces for other chars
    value: undefined, // Comments don't have a semantic value
  };
}

// :: tuple string -> rawToken
function fNumber(m: RegExpExecArray): RawToken {
  // Handles numbers (integers, floats, exponents)
  return {
    type: "number",
    match: m[0], // The raw matched number string
    value: Number.parseFloat(m[0]), // Convert string to number
  };
}

// :: tuple ("null" | "true" | "false") -> rawToken
function fKeyword(m: RegExpExecArray): RawToken {
  // Handles JSON keywords: null, true, false
  let value: null | boolean;
  switch (m[0]) {
    case "null":
      value = null;
      break;
    case "true":
      value = true;
      break;
    case "false":
      value = false;
      break;
    default:
      // Should be unreachable due to regex, but satisfies TypeScript exhaustiveness check
      throw new Error(`Unexpected keyword: ${m[0]}`);
  }
  return {
    type: "atom", // Use 'atom' type for these literals
    match: m[0], // The raw matched keyword
    value, // The corresponding JavaScript value
  };
}

// --- Token Specification Creation ---

// :: boolean -> array tokenSpec
function makeTokenSpecs(relaxed: boolean): TokenSpec[] {
  // Helper to create a simple token spec function
  // :: string -> fn
  function f(type: TokenType): (m: RegExpExecArray) => RawToken {
    // :: tuple string -> rawToken
    return (m: RegExpExecArray): RawToken => {
      // For simple tokens like punctuation, value is not needed
      return { type, match: m[0], value: undefined };
    };
  }

  // Base JSON token specifications (strict)
  let tokenSpecs: TokenSpec[] = [
    { re: WHITESPACE_REGEX, f: f(" ") }, // Whitespace
    { re: OBJECT_START_REGEX, f: f("{") }, // Object start
    { re: OBJECT_END_REGEX, f: f("}") }, // Object end
    { re: ARRAY_START_REGEX, f: f("[") }, // Array start
    { re: ARRAY_END_REGEX, f: f("]") }, // Array end
    { re: COMMA_REGEX, f: f(",") }, // Comma separator
    { re: COLON_REGEX, f: f(":") }, // Key-value separator
    { re: KEYWORD_REGEX, f: fKeyword }, // Keywords
    // Number: optional sign, digits, optional decimal part, optional exponent
    { re: NUMBER_REGEX, f: fNumber },
    // String: double-quoted, handles escapes
    { re: STRING_DOUBLE_REGEX, f: fStringDouble },
  ];

  // Add relaxed syntax rules if requested
  if (relaxed) {
    tokenSpecs = tokenSpecs.concat([
      // Single-quoted strings
      {
        re: STRING_SINGLE_REGEX,
        f: fStringSingle,
      },
      // Single-line comments (// ...)
      { re: COMMENT_SINGLE_REGEX, f: fComment },
      // Multi-line comments (/* ... */)
      { re: COMMENT_MULTI_REGEX, f: fComment },
      // Unquoted identifiers (treated as strings)
      // Allows letters, numbers, _, -, +, ., *, ?, !, |, &, %, ^, /, #, \
      { re: IDENTIFIER_REGEX, f: fIdentifier },
      // Note: The order matters here. Identifiers are checked after keywords/numbers.
    ]);
  }

  return tokenSpecs;
}

// Create lexer instances
const lexer = makeLexer(makeTokenSpecs(true)); // Relaxed syntax lexer
const strictLexer = makeLexer(makeTokenSpecs(false)); // Strict JSON lexer

// --- Parser Helper Functions ---

// Find the index of the previous non-whitespace token
// :: array token -> nat -> nat?
function previousNWSToken(tokens: Token[], index: number): number | undefined {
  for (; index >= 0; index--) {
    if (tokens[index].type !== " ") {
      return index; // Return index of the non-whitespace token
    }
  }
  return; // Not found
}

// Removes trailing commas from arrays and objects in a token stream
// :: array token -> array token
function stripTrailingComma(tokens: Token[]): Token[] {
  const res: Token[] = [];

  tokens.forEach((token, index) => {
    // Check if the current token is a closing bracket or brace
    if (index > 0 && (token.type === "]" || token.type === "}")) {
      // Find the last non-whitespace token *before* this closing token in the result array 'res'
      const prevNWSTokenIndex = previousNWSToken(res, res.length - 1); // Look in `res`, not `tokens`!

      // Check if it's a comma
      if (
        prevNWSTokenIndex !== undefined &&
        res[prevNWSTokenIndex].type === ","
      ) {
        // Find the token *before* the comma
        const preCommaIndex = previousNWSToken(res, prevNWSTokenIndex - 1);

        // Ensure there *was* a token before the comma, and it wasn't an opening bracket/brace
        // This prevents removing the comma in `[,1]` or `{, "a":1}` which is invalid anyway
        if (
          preCommaIndex !== undefined &&
          res[preCommaIndex].type !== "[" &&
          res[preCommaIndex].type !== "{"
        ) {
          // Replace the trailing comma with a whitespace token
          res[prevNWSTokenIndex] = {
            type: " ",
            match: " ", // Represent as a single space
            value: undefined, // Whitespace has no value
            line: res[prevNWSTokenIndex].line, // Preserve original line number
          };
        }
      }
    }

    res.push(token); // Add the current token (or the original closing bracket/brace)
  });

  return res;
}

/**
 * Transform relaxed JSON syntax to standard JSON string
 *
 * Converts relaxed JSON features (unquoted keys, single quotes, trailing commas, comments)
 * into valid standard JSON syntax that can be parsed by native JSON.parse().
 *
 * @param text - The relaxed JSON string to transform
 * @returns A standard JSON string
 *
 * @example
 * ```typescript
 * transform('{key: "value", trailing: "comma",}')
 * // Returns: '{"key": "value", "trailing": "comma"}'
 *
 * transform("{'single': 'quotes'}")
 * // Returns: '{"single": "quotes"}'
 * ```
 */
function transform(text: string): string {
  // Tokenize contents using the relaxed lexer
  let tokens = lexer(text);

  // Remove trailing commas if present
  tokens = stripTrailingComma(tokens);

  // Concatenate the 'match' part of each token back into a single string
  return tokens.reduce((str, token) => str + token.match, "");
}

// --- Parsing Core Functions ---

// Get the next token from the stream and advance the position
// :: array parseToken -> parseState -> *
function popToken(tokens: Token[], state: ParseState): Token {
  const token = tokens[state.pos];
  state.pos += 1;

  if (!token) {
    // If we are past the end of the token array, return an EOF token
    const lastLine = tokens.length !== 0 ? tokens.at(-1)!.line : 1;
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
    if (valid && valid.includes(token.type)) {
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

// Appends a key-value pair to an object, applying the reviver function if present
// :: parseState -> any -> any -> any -> undefined
function appendPair(
  state: ParseState,
  obj: { [key: string]: unknown },
  key: string,
  value: unknown
): void {
  // Apply reviver function if it exists
  const finalValue = state.reviver ? state.reviver(key, value) : value;
  // The reviver can return undefined to omit the key/value pair
  if (finalValue !== undefined) {
    obj[key] = finalValue;
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
function handleCommaToken<T>(
  token: Token,
  tokens: Token[],
  state: ParseState,
  opts: ParseManyOpts<T>,
  result: T
): T | null {
  const nextToken = tokens[state.pos];
  if (state.tolerant && nextToken && nextToken.type === opts.endSymbol) {
    raiseError(state, token, `Trailing comma before '${opts.endSymbol}'`);
    popToken(tokens, state);
    return result;
  }
  opts.elementParser(tokens, state, result);
  return null; // Signal to continue parsing
}

// Generic function to parse comma-separated elements within enclosing symbols (like objects or arrays)
// :: t : array | {} => array parseToken -> parseState -> t -> parseManyOpts -> t
function parseMany<T>(
  tokens: Token[],
  state: ParseState,
  result: T,
  opts: ParseManyOpts<T>
): T {
  let token = skipPunctuation(tokens, state, opts.skip);

  if (token.type === "eof") {
    raiseUnexpected(state, token, `'${opts.endSymbol}' or ${opts.elementName}`);
    if (state.tolerant) {
      return result;
    }
    return result;
  }

  if (token.type === opts.endSymbol) {
    return result;
  }

  state.pos -= 1;
  opts.elementParser(tokens, state, result);

  while (true) {
    token = popToken(tokens, state);

    if (token.type !== opts.endSymbol && token.type !== ",") {
      const handledResult = handleInvalidToken(token, state, opts, result);
      if (handledResult !== null) {
        return handledResult;
      }
    }

    switch (token.type) {
      case opts.endSymbol:
        return result;

      case ",": {
        const handledResult = handleCommaToken(token, tokens, state, opts, result);
        if (handledResult !== null) {
          return handledResult;
        }
        break;
      }

      default:
        opts.elementParser(tokens, state, result);
        break;
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
  options.warnings = options.warnings;
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
function parseWithCustomParser(
  text: string,
  options: ParseOptions
): unknown {
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
function parseWithTransform(
  text: string,
  options: ParseOptions
): unknown {
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
  if (!(options.relaxed || options.warnings || options.tolerant) && options.duplicate) {
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

// --- Stringify Function (Basic Implementation) ---
// Note: This is a basic, non-configurable stringifier, mainly for potential internal use or testing.
// It doesn't handle replacer/space arguments like JSON.stringify.

// Helper for stringifying object pairs
// :: any -> string -> ... -> string
function stringifyPair(obj: { [key: string]: unknown }, key: string): string {
  // Stringify key and value, then join with colon
  // Recursively calls stringify for the value
  return JSON.stringify(key) + ":" + stringify(obj[key]);
}

/**
 * Convert JavaScript value to JSON string with sorted object keys
 *
 * Similar to JSON.stringify but with consistent key ordering (sorted alphabetically).
 * Handles undefined values by converting them to null.
 *
 * @param obj - The value to convert to JSON string
 * @returns A JSON string representation
 *
 * @example
 * ```typescript
 * stringify({z: 1, a: 2, m: 3})
 * // Returns: '{"a":2,"m":3,"z":1}' (keys sorted)
 *
 * stringify({key: undefined})
 * // Returns: '{"key":null}' (undefined becomes null)
 * ```
 */
function stringify(obj: unknown): string {
  const type = typeof obj;

  // Handle primitives directly using JSON.stringify (handles escaping etc.)
  if (
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    obj === null
  ) {
    return JSON.stringify(obj);
  }

  // Handle undefined (represented as null in this basic version, JSON.stringify omits in objects/returns undefined at top level)
  if (type === "undefined") {
    return "null";
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    // Recursively stringify each element and join with commas
    const elements = obj.map(stringify).join(",");
    return "[" + elements + "]";
  }

  // Handle objects
  // Check if it's a non-null object (using constructor check is less robust than typeof + null check)
  if (type === "object") {
    // Already checked for null and Array above
    // Get keys, sort them for consistent output (optional, but good practice)
    const keys = Object.keys(obj as object);
    keys.sort();
    // Stringify each key-value pair and join with commas
    const pairs = keys
      .map((key) => stringifyPair(obj as { [key: string]: unknown }, key))
      .join(",");
    return "{" + pairs + "}";
  }

  // Fallback for unsupported types (like functions, symbols) - represent as null
  return "null";
}

export { parse, stringify, transform };
export type { ParseOptions };
