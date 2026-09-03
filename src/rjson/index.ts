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

import { transform as transformRelaxedJson } from "./lexer";
import { parse as parseJson } from "./parse";
import type { ParseOptions } from "./parser-types";
import { stringify as stringifyValue } from "./stringify";

/**
 * Parse a JSON string with enhanced features beyond standard JSON.parse().
 *
 * Supports both strict JSON and relaxed JSON syntax with configurable error
 * handling and duplicate key validation.
 *
 * @param text - The JSON string to parse
 * @param optsOrReviver - Either parser options or a JSON.parse-compatible reviver
 * @returns The parsed JavaScript value
 * @throws {SyntaxError} When parsing fails in strict or warning mode
 */
function parse(
  text: string,
  optsOrReviver?: ParseOptions | ((key: string, value: unknown) => unknown)
): unknown {
  return parseJson(text, optsOrReviver);
}

function transform(text: string): string {
  return transformRelaxedJson(text);
}

function stringify(value: unknown): string {
  return stringifyValue(value);
}

export type { ParseOptions } from "./parser-types";
export { parse, stringify, transform };
