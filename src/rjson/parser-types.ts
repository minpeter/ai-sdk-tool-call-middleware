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

interface ParseWarning {
  readonly line: number;
  readonly message: string;
}

export interface RevivedObject<Extension> {
  [key: string]: RevivedValue<Extension> | undefined;
}

export type RevivedArray<Extension> = RevivedValue<Extension>[];

export type RevivedValue<Extension> =
  | null
  | string
  | number
  | boolean
  | RevivedObject<Extension>
  | RevivedArray<Extension>
  | Extension;

export type Reviver<Extension> = (
  key: string,
  value: RevivedValue<Extension> | undefined
) => RevivedValue<Extension> | undefined;

declare const reviverBrand: unique symbol;

type ReviverBrandTag<Extension> = (extension: Extension) => Extension;

/**
 * An opaque reviver created by {@link defineReviver}.
 *
 * Unlike a plain `Reviver`, this witness opts into precise extension-aware
 * inference from `parse`. Its required private brand is invariant in
 * `Extension` and cannot be supplied by ordinary callback annotations.
 */
export interface ReviverWitness<Extension> extends Reviver<Extension> {
  readonly [reviverBrand]: ReviverBrandTag<Extension>;
}

/**
 * Create an opaque reviver witness for precise `parse` result inference.
 *
 * This cast is the trust root for the private compile-time brand. The brand has
 * no runtime representation; parameter checking ensures `fn` accepts and
 * returns exactly the recursive domain declared by `Extension`.
 */
export function defineReviver<Extension>(
  fn: Reviver<Extension>
): ReviverWitness<Extension> {
  return fn as ReviverWitness<Extension>;
}

// Mutable parser cursor and warning accumulator.
export interface ParseState {
  duplicate: boolean; // true = allow duplicate keys (use last value), false = reject duplicate keys with error
  pos: number; // Current position in the token array
  tolerant: boolean;
  warnings: ParseWarning[];
}

/**
 * Options for configuring JSON parsing behavior
 */
export interface ParseOptions<Extension = never> {
  /**
   * Allow duplicate object keys in JSON.
   * - true: Allow duplicates (uses last value, like native JSON.parse)
   * - false: Reject duplicates with error (enforces JSON specification)
   * @default false
   */
  readonly duplicate?: boolean;
  /**
   * Enable relaxed JSON syntax parsing (unquoted keys, single quotes, trailing commas, comments)
   * @default true
   */
  readonly relaxed?: boolean;

  /**
   * Optional reviver function to transform parsed values (same as JSON.parse reviver)
   * @param key - The object key or array index
   * @param value - The parsed value, or undefined if an earlier callback deleted it
   * @returns The transformed value
   */
  readonly reviver?: Reviver<Extension>;

  /**
   * Continue parsing when encountering recoverable errors, collecting warnings.
   * In strict mode (false), throws immediately on first error.
   * @default false
   */
  readonly tolerant?: boolean;

  /**
   * Collect parsing warnings instead of throwing immediately. Implies tolerant mode.
   * After parsing a value, collected warnings throw with warning details.
   * @default false
   */
  readonly warnings?: boolean;
}

export type ParseOptionsWithoutReviver = Omit<ParseOptions, "reviver"> & {
  readonly reviver?: never;
};

export type PresentParseOptions<Extension> = ParseOptions<Extension> & {
  readonly tolerant?: false;
  readonly warnings?: false;
};

// Type for options specific to the parseMany function
export interface ParseManyOpts<T> {
  readonly elementName: string; // Name of the expected element for error messages
  readonly elementParser: (tokens: Token[], state: ParseState, obj: T) => void; // Function to parse an element/pair
  readonly endSymbol: TokenType; // The token type that marks the end of the structure (']' or '}')
  readonly skip: TokenType[]; // Token types to skip initially
}

// --- Parser Helper Functions ---
