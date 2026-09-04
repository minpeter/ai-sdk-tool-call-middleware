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

import type { Token } from "./lexer";
import { parseArray, parseObject } from "./parser-collections";
import { endChecks, raiseUnexpected, skipPunctuation } from "./parser-state";
import type { ParseState } from "./parser-types";

export function parseAny(
  tokens: Token[],
  state: ParseState,
  end = false
): JSONValue | undefined {
  // Skip any leading punctuation (useful for recovery in tolerant mode)
  const token = skipPunctuation(tokens, state);
  let ret: JSONValue | undefined; // Variable to hold the parsed result

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
      if (typeof token.value === "string") {
        ret = token.value;
        break;
      }
      raiseUnexpected(state, token, "string value");
      return;
    case "number": // Number literal
      if (typeof token.value === "number") {
        ret = token.value;
        break;
      }
      raiseUnexpected(state, token, "number value");
      return;
    case "atom": // Keyword literal (true, false, null)
      if (token.value === null || typeof token.value === "boolean") {
        ret = token.value;
        break;
      }
      raiseUnexpected(state, token, "true, false or null");
      return;
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
    // Perform final checks for trailing tokens or accumulated warnings
    endChecks(tokens, state, ret);
  }

  return ret;
}

// Helper to normalize parse options
