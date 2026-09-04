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

import { transform as transformSource } from "./lexer";
import { parse as parseSource } from "./parse";
import { stringify as stringifySource } from "./stringify";

/**
 * Parse a JSON string with enhanced features beyond standard `JSON.parse`.
 *
 * Supports strict and relaxed JSON syntax, duplicate-key handling, tolerant
 * parsing, and JSON-compatible revivers. Revivers that emit non-JSON values
 * receive their recursively revived extension through `RevivedValue`.
 *
 * @param text - The JSON string to parse
 * @param options - Parser options or a reviver callback
 * @returns A JSON value or reviver output; tolerant empty input returns `undefined`
 * @throws {SyntaxError} When parsing fails in strict or warning mode
 */
export const parse: typeof parseSource = parseSource;

/** Convert relaxed JSON syntax into strict JSON text. */
export const transform: typeof transformSource = transformSource;

/** Serialize an RJSON value with deterministic object-key ordering. */
export const stringify: typeof stringifySource = stringifySource;

export type {
  ParseOptions,
  RevivedArray,
  RevivedObject,
  RevivedValue,
  Reviver,
} from "./parser-types";
export type { Rjson } from "./stringify";
