import type {
  LanguageModelV4Content,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import { parse as parseRJSON } from "../../rjson";
import { logParseFailure } from "../utils/debug";
import { recoverToolCallFromJsonCandidates } from "../utils/generated-text-json-recovery";
import { generateToolCallId } from "../utils/id";
import {
  safeToolCallMetadataError,
  safeToolCallMetadataText,
} from "../utils/protocol-utils";
import {
  toolCallInputHasPrototypeSensitiveKey,
  toolCallTextHasPrototypeSensitiveKey,
} from "../utils/prototype-sensitive-keys";
import {
  type ArgumentKeyPolicy,
  ArgumentKeyPolicyError,
  applyArgumentKeyPolicy,
  containsPrototypeSensitiveArgumentKey,
  extractArgumentKeyPolicy,
  hasPrototypeSensitiveKeyInJsonLikeObject,
  isArgumentKeyPolicyError,
  isRecord,
} from "./hermes-argument-key-policy";
import { argumentValueMatchesSchemaKeyShape } from "./hermes-argument-schema";
import {
  isParsedToolCallRecord,
  normalizeJsonStringCtrl,
  stringifyParsedToolInput,
  stringifyResolvedToolInput,
} from "./hermes-json-normalization";
import { exceedsToolCallJsonNestingDepth } from "./hermes-json-object-key-scanner";
import {
  normalizeInvalidJsonEscapes,
  repairToolCallJsonForTools,
  topLevelNullArgumentMatchesToolSchema,
} from "./hermes-json-repair";
import { extractStreamingToolCallProgress } from "./hermes-streaming-progress";
import type { ParserOptions } from "./protocol-interface";

/**
 * Hermes call-parsing primitives shared by the generate-path parser and the
 * streaming state machine in hermes-protocol.ts: relaxed JSON scanning and
 * repair, argument-body recovery, key-policy coercion, and boundary-safe
 * string handling for `<tool_call>` JSON payloads.
 */
function tryParseDoubleEncodedArguments(
  args: string
): Record<string, unknown> | null {
  if (!args.trimStart().startsWith("{")) {
    return null;
  }
  if (hasPrototypeSensitiveKeyInJsonLikeObject(args)) {
    return null;
  }
  try {
    const parsed = parseRJSON(
      normalizeInvalidJsonEscapes(normalizeJsonStringCtrl(args))
    );
    return isRecord(parsed) && !containsPrototypeSensitiveArgumentKey(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function applyNonRecordArgumentPolicy(
  toolName: string,
  args: Exclude<unknown, Record<string, unknown>>,
  tools: LanguageModelV4FunctionTool[],
  keyPolicy: ArgumentKeyPolicy | undefined
): { args: unknown } | null {
  if (args === null) {
    return topLevelNullArgumentMatchesToolSchema(toolName, tools)
      ? { args }
      : null;
  }
  if (toolCallInputHasPrototypeSensitiveKey(args)) {
    return null;
  }
  if (
    keyPolicy &&
    argumentValueMatchesSchemaKeyShape(args, keyPolicy.schema, new Set(), true)
  ) {
    return { args };
  }
  if (typeof args === "string") {
    const unwrapped = tryParseDoubleEncodedArguments(args);
    if (unwrapped) {
      const unwrappedPolicyArgs = applyArgumentKeyPolicy(unwrapped, keyPolicy);
      if (unwrappedPolicyArgs !== null) {
        return { args: unwrappedPolicyArgs };
      }
    }
  }
  if (keyPolicy?.rejectNonRecordArguments) {
    return null;
  }
  return { args };
}

export function applyToolArgumentKeyPolicy(
  toolName: string,
  args: unknown,
  tools: LanguageModelV4FunctionTool[]
): { args: unknown } | null {
  const keyPolicy = extractArgumentKeyPolicy(tools, toolName);
  if (keyPolicy?.rejectAll) {
    return null;
  }
  const normalizedArgs = args === undefined ? {} : args;
  if (!isRecord(normalizedArgs)) {
    return applyNonRecordArgumentPolicy(
      toolName,
      normalizedArgs,
      tools,
      keyPolicy
    );
  }
  const policyArgs = applyArgumentKeyPolicy(normalizedArgs, keyPolicy);
  return policyArgs === null ? null : { args: policyArgs };
}

type ResolvedToolCall =
  | { ok: true; toolName: string; input: string }
  | { ok: false; error: unknown };

/**
 * Single source of truth for turning a raw `<tool_call>` JSON body into a
 * canonical `{ toolName, input }` pair (or a failure). Performs, in order:
 *
 *   1. relaxed-JSON parse (with raw control-character normalization)
 *   2. shape validation (must be an object with a string `name`)
 *   3. prototype-pollution guard
 *   4. argument key-policy enforcement
 *   5. final input stringification (schema-aware)
 *
 * On any failure it makes one best-effort repair attempt (e.g. unescaped quotes)
 * and, if that also fails, reports the originating error. The stringification is
 * performed inside the same `try` as parsing so that a stringify failure falls
 * through to the repair path exactly as it did when this logic was inlined in
 * each caller — the two paths must stay byte-for-byte equivalent here.
 */
export function resolveToolCall(
  toolCallJson: string,
  tools: LanguageModelV4FunctionTool[]
): ResolvedToolCall {
  // Fail closed before recursive RJSON/JSON.parse/stringify can hang or
  // stack-overflow on pathologically nested arguments (arrays/objects).
  if (exceedsToolCallJsonNestingDepth(toolCallJson)) {
    return {
      ok: false,
      error: new Error("Tool call JSON nesting depth exceeds limit"),
    };
  }
  try {
    const parsedToolCall = parseRJSON(
      normalizeInvalidJsonEscapes(normalizeJsonStringCtrl(toolCallJson))
    );
    if (!isParsedToolCallRecord(parsedToolCall)) {
      throw new Error("Tool call object is missing own name or arguments");
    }
    if (hasPrototypeSensitiveKeyInJsonLikeObject(toolCallJson)) {
      throw new Error("Tool call arguments contain prototype-sensitive keys");
    }
    const policyArguments = applyToolArgumentKeyPolicy(
      parsedToolCall.name,
      parsedToolCall.arguments,
      tools
    );
    if (policyArguments === null) {
      throw new ArgumentKeyPolicyError(
        "Tool call arguments were rejected by schema key policy"
      );
    }
    return {
      ok: true,
      toolName: parsedToolCall.name,
      input: stringifyResolvedToolInput(
        parsedToolCall.name,
        policyArguments.args,
        tools
      ),
    };
  } catch (error) {
    const parseError =
      error instanceof Error ? error : new Error(String(error));
    if (isArgumentKeyPolicyError(parseError)) {
      return { ok: false, error: parseError };
    }
    // Attempt repair for unescaped quotes (best-effort).
    const repaired = repairToolCallJsonForTools(toolCallJson, tools);
    if (repaired) {
      try {
        return {
          ok: true,
          toolName: repaired.name,
          input: stringifyResolvedToolInput(
            repaired.name,
            repaired.arguments,
            tools
          ),
        };
      } catch (repairError) {
        return {
          ok: false,
          error:
            repairError instanceof Error
              ? repairError
              : new Error(String(repairError)),
        };
      }
    }
    return { ok: false, error: parseError };
  }
}

/** Whitespace and complete tag-like tokens only (e.g. a stray `</think>`). */
const MARKUP_ONLY_TEXT_REGEX = /^\s*(?:<[^<>\n]*>\s*)*$/;

/**
 * Run the shared JSON-candidate recovery over `text` and return every
 * recovered call for known tools, in `ResolvedToolCall` success shape.
 *
 * The salvage is deliberately narrow so it cannot override the primary
 * parser's intentional fallbacks:
 *   - the body must consist solely of tool payloads plus markup remnants
 *     (whitespace or complete tag-like tokens such as a mismatched
 *     `</think>` close tag or `<tool_call>` separators). Bodies whose parse
 *     failed mid-object (e.g. unescaped quotes, trailing top-level fields)
 *     keep falling back to text.
 *   - prototype-sensitive keys are re-checked on the raw text, and recovered
 *     arguments go through the same argument key policy as the primary path.
 */
export function recoverKnownToolCallsFromText(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): Extract<ResolvedToolCall, { ok: true }>[] | null {
  if (hasPrototypeSensitiveKeyInJsonLikeObject(text)) {
    return null;
  }

  const recoveredParts = recoverToolCallFromJsonCandidates(text, tools);
  if (!recoveredParts) {
    return null;
  }

  const calls: Extract<ResolvedToolCall, { ok: true }>[] = [];
  for (const part of recoveredParts) {
    if (part.type === "text") {
      if (!MARKUP_ONLY_TEXT_REGEX.test(part.text)) {
        return null;
      }
      continue;
    }
    if (part.type !== "tool-call") {
      return null;
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(part.input);
    } catch {
      return null;
    }
    const policyArguments = applyToolArgumentKeyPolicy(
      part.toolName,
      parsedArgs,
      tools
    );
    if (policyArguments === null) {
      return null;
    }

    try {
      calls.push({
        ok: true,
        toolName: part.toolName,
        input: stringifyParsedToolInput(policyArguments.args),
      });
    } catch {
      return null;
    }
  }

  return calls.length > 0 ? calls : null;
}

export function processToolCallJson(
  toolCallJson: string,
  fullMatch: string,
  processedElements: LanguageModelV4Content[],
  tools: LanguageModelV4FunctionTool[],
  options?: ParserOptions
) {
  const resolved = resolveToolCall(toolCallJson, tools);
  if (resolved.ok) {
    processedElements.push({
      type: "tool-call",
      toolCallId: generateToolCallId(),
      toolName: resolved.toolName,
      input: resolved.input,
    });
    return;
  }

  if (!isArgumentKeyPolicyError(resolved.error)) {
    const salvagedCalls = recoverKnownToolCallsFromText(toolCallJson, tools);
    if (salvagedCalls && salvagedCalls.length > 0) {
      for (const salvagedCall of salvagedCalls) {
        processedElements.push({
          type: "tool-call",
          toolCallId: generateToolCallId(),
          toolName: salvagedCall.toolName,
          input: salvagedCall.input,
        });
      }
      return;
    }
  }

  const salvagedToolName =
    extractStreamingToolCallProgress(toolCallJson).toolName;
  const salvagedToolCallId = generateToolCallId();
  logParseFailure({
    phase: "generated-text",
    reason: "Failed to parse tool call JSON segment",
    snippet: fullMatch,
    error: resolved.error,
  });
  options?.onError?.(
    "Could not process JSON tool call, keeping original text.",
    {
      toolCall: safeToolCallMetadataText(fullMatch),
      error: safeToolCallMetadataError(resolved.error, fullMatch),
      toolName: salvagedToolName,
      toolCallId: salvagedToolCallId,
      dropReason: "malformed-tool-call-body",
    }
  );
  if (toolCallTextHasPrototypeSensitiveKey(fullMatch)) {
    return;
  }
  processedElements.push({ type: "text", text: fullMatch });
}
