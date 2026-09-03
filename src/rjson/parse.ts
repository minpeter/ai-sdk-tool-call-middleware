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

import { lexer, strictLexer, stripTrailingComma } from "./lexer";
import type { ParseOptions, ParseState } from "./parser-types";
import { parseAny } from "./parser-value";

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

export { parse };
