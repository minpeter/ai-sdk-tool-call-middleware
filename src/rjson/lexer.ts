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
  for (let i = 0; i < array.length; i += 1) {
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
interface TokenSpec {
  // Function to process the regex match and return a RawToken
  f: (match: RegExpExecArray) => RawToken;
  re: RegExp;
}

// Literal types for possible token types
export type TokenType =
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
interface RawToken {
  match: string; // The raw matched text
  type: TokenType;
  value?: unknown; // The parsed value (for strings, numbers, atoms)
}

// Type for a token including line number information
export type Token = RawToken & {
  line: number;
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
    let remainingContents = contents;

    // Helper function to find the next token in the input string
    // :: -> { raw: string, matched: RawToken } | undefined
    function findToken(): { raw: string; matched: RawToken } | undefined {
      // Use the custom 'some' function to iterate through token specifications
      const result = some(tokenSpecs, (tokenSpec) => {
        const m = tokenSpec.re.exec(remainingContents); // Try to match the regex at the current position
        if (m) {
          const [raw] = m; // The matched raw string
          remainingContents = remainingContents.slice(raw.length); // Consume the matched part from the input
          return {
            raw,
            matched: tokenSpec.f(m), // Process the match using the spec's function
          };
        }
      });
      return result === false ? undefined : result;
    }

    // Main lexing loop
    while (remainingContents !== "") {
      const matched = findToken(); // Find the next token

      if (!matched) {
        // If no token spec matches, it's a syntax error
        const err = new SyntaxError(
          `Unexpected character: ${remainingContents[0]}; input: ${remainingContents.slice(
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
  const [value] = m;
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
  const match = m[0].replace(/./g, (c) =>
    WHITESPACE_TEST_REGEX.test(c) ? c : " "
  );
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
export const lexer = makeLexer(makeTokenSpecs(true)); // Relaxed syntax lexer
export const strictLexer = makeLexer(makeTokenSpecs(false)); // Strict JSON lexer

// Find the index of the previous non-whitespace token
// :: array token -> nat -> nat?
function previousNWSToken(tokens: Token[], index: number): number | undefined {
  let currentIndex = index;
  for (; currentIndex >= 0; currentIndex -= 1) {
    if (tokens[currentIndex].type !== " ") {
      return currentIndex; // Return index of the non-whitespace token
    }
  }
}

// Removes trailing commas from arrays and objects in a token stream
// :: array token -> array token
export function stripTrailingComma(tokens: Token[]): Token[] {
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
export function transform(text: string): string {
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
