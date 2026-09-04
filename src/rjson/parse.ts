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

import type { JSONValue } from "@ai-sdk/provider";

import { lexer, strictLexer, stripTrailingComma } from "./lexer";
import type {
  ParseOptions,
  ParseOptionsWithoutReviver,
  ParseState,
  PresentParseOptions,
  RevivedValue,
  Reviver,
} from "./parser-types";
import { parseAny } from "./parser-value";

type JsonReviver<Output extends JSONValue | undefined> = (
  key: string,
  value: JSONValue
) => Output;

type FunctionWithNoParameters<Factory extends (...args: never[]) => void> =
  Factory & (Parameters<Factory> extends [] ? Factory : never);

type ParseConfiguration = Omit<ParseOptions<never>, "reviver">;

type FactoryOptionResult<Tolerant, Warnings, Output> = true extends
  | Tolerant
  | Warnings
  ? Output | undefined
  : Output;

type ParseOptionsExtension<Options> =
  Options extends ParseOptions<infer Extension> ? Extension : never;

type GeneralParseOptionResult<Options> = Options extends {
  readonly reviver: Reviver<ParseOptionsExtension<Options>>;
}
  ? RevivedValue<ParseOptionsExtension<Options>> | undefined
  : ParseOptionResult<Options, JSONValue>;

type CheckedParseOptions<Options> =
  Options extends ParseOptions<ParseOptionsExtension<Options>>
    ? Options
    : never;

type PresentRecursiveReviver<Extension> = (
  key: string,
  value: RevivedValue<Extension>
) => RevivedValue<Extension>;

type RecursiveReviver<Extension> = (
  key: string,
  value: RevivedValue<Extension>
) => RevivedValue<Extension> | undefined;

type ParseOptionResult<Options, Output> = Options extends {
  readonly tolerant?: false;
  readonly warnings?: false;
}
  ? Output
  : Output | undefined;

function normalizeParseOptions<Output>(
  optsOrReviver: ParseOptions<Output> | Reviver<Output> | undefined
): ParseOptions<Output> {
  let options: ParseOptions<Output>;

  if (typeof optsOrReviver === "function") {
    options = { reviver: optsOrReviver };
  } else if (optsOrReviver !== null && typeof optsOrReviver === "object") {
    options = { ...optsOrReviver };
  } else if (optsOrReviver === undefined) {
    options = {};
  } else {
    throw new TypeError(
      "Second argument must be a reviver function or an options object."
    );
  }

  const relaxed =
    options.relaxed ??
    !(options.warnings === false && options.tolerant === false);

  return {
    ...options,
    duplicate: options.duplicate ?? false,
    relaxed,
    tolerant: options.tolerant || options.warnings,
  };
}

// Helper to create parser state
function createParseState<Extension>(
  options: ParseOptions<Extension>
): ParseState {
  return {
    pos: 0,
    tolerant: options.tolerant ?? false,
    duplicate: options.duplicate ?? false,
    warnings: [],
  };
}

// Helper to use custom parser with tokens
function parseWithCustomParser<Extension>(
  text: string,
  options: ParseOptions<Extension>
): JSONValue | undefined {
  const lexerToUse = options.relaxed ? lexer : strictLexer;
  let tokens = lexerToUse(text);

  if (options.relaxed) {
    tokens = stripTrailingComma(tokens);
  }

  tokens = tokens.filter((token) => token.type !== " ");
  const state = createParseState(options);
  return parseAny(tokens, state, true);
}

function setRevivedProperty<Extension>(
  holder: object,
  key: string,
  revived: RevivedValue<Extension> | undefined
): void {
  if (revived === undefined) {
    Reflect.deleteProperty(holder, key);
    return;
  }
  Object.defineProperty(holder, key, {
    configurable: true,
    enumerable: true,
    value: revived,
    writable: true,
  });
}

function reviveValue<Extension>(
  holder: object,
  key: string,
  reviver: Reviver<Extension>
): RevivedValue<Extension> | undefined {
  const value: RevivedValue<Extension> | undefined = Reflect.get(holder, key);

  if (Array.isArray(value)) {
    const { length } = value;
    for (let index = 0; index < length; index += 1) {
      const elementKey = String(index);
      setRevivedProperty(
        value,
        elementKey,
        reviveValue(value, elementKey, reviver)
      );
    }
  } else if (typeof value === "object" && value !== null) {
    for (const propertyKey of Object.keys(value)) {
      setRevivedProperty(
        value,
        propertyKey,
        reviveValue(value, propertyKey, reviver)
      );
    }
  }

  return Reflect.apply(reviver, holder, [key, value]);
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
 * @returns The parsed value, or undefined when tolerant input contains no value
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
function parse<Output extends JSONValue | undefined>(
  text: string,
  reviver: JsonReviver<Output>
): Output;
function parse<Factory extends (...args: never[]) => void>(
  text: string,
  reviver: FunctionWithNoParameters<Factory>
): ReturnType<Factory>;
function parse<Extension>(
  text: string,
  reviver: PresentRecursiveReviver<Extension>
): RevivedValue<Extension>;
function parse<Extension>(
  text: string,
  reviver: RecursiveReviver<Extension>
): RevivedValue<Extension> | undefined;
function parse(
  text: string,
  options?: PresentParseOptions<never> & { readonly reviver?: never }
): JSONValue;
function parse<Options extends ParseOptionsWithoutReviver>(
  text: string,
  options: Options
): ParseOptionResult<Options, JSONValue>;
function parse<
  Factory extends (...args: never[]) => void,
  Tolerant extends boolean | undefined = undefined,
  Warnings extends boolean | undefined = undefined,
>(
  text: string,
  options: ParseConfiguration & {
    readonly reviver: FunctionWithNoParameters<Factory>;
    readonly tolerant?: Tolerant;
    readonly warnings?: Warnings;
  }
): FactoryOptionResult<Tolerant, Warnings, ReturnType<Factory>>;
function parse<Extension = never>(
  text: string,
  options: Omit<ParseOptions<NoInfer<Extension>>, "reviver"> & {
    readonly reviver: Reviver<NoInfer<Extension>>;
  }
): RevivedValue<Extension> | undefined;
function parse<Options>(
  text: string,
  options: Options & CheckedParseOptions<Options>
): GeneralParseOptionResult<Options>;

function parse<Output>(
  text: string,
  optsOrReviver?: ParseOptions<Output> | Reviver<Output>
): RevivedValue<Output> | undefined {
  const options = normalizeParseOptions(optsOrReviver);
  const parsed = parseWithCustomParser(text, options);
  if (parsed === undefined || options.reviver === undefined) {
    return parsed;
  }
  return reviveValue({ "": parsed }, "", options.reviver);
}

export { parse };
