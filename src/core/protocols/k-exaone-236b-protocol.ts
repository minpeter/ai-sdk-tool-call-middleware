import {
  isJSONValue,
  type JSONValue,
  type LanguageModelV4FunctionTool,
  type LanguageModelV4ToolCall,
} from "@ai-sdk/provider";
import { z } from "zod";
import {
  decodeKExaone2HistoryKey,
  parseKExaone2LosslessJson,
} from "../prompts/k-exaone-2-lossless-json";
import { KExaone2HistoryNumber } from "../prompts/k-exaone-2-lossless-json-tokens";
import {
  type KExaone2Value,
  stringifyKExaone2CompactJson,
  stringifyKExaone2NativeJson,
} from "../prompts/k-exaone-2-native-json";
import { resolveToolCall } from "./hermes-call-parsing";
import { normalizeJsonStringCtrl } from "./hermes-json-normalization";
import { normalizeInvalidJsonEscapes } from "./hermes-json-repair";
import { hermesProtocol } from "./hermes-protocol";
import { extractStreamingToolCallProgress } from "./hermes-streaming-progress";
import { parseKExaoneToolCallInput } from "./k-exaone-tool-call-input";
import type {
  ResolvedProtocolToolCall,
  TCMProtocol,
} from "./protocol-interface";

const TRAILING_COMMA_REGEX = /,(\s*[}\]])/g;
const ARGUMENTS_FIELD_REGEX = /([,{]\s*)(["'])arguments\2\s*:/;
const PARAMETERS_FIELD_REGEX = /([,{]\s*)(["'])parameters\2\s*:/;

type KExaone236BJsonValue = KExaone2Value;

const kExaone236BJsonValueSchema: z.ZodType<KExaone236BJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.string(),
    z.number(),
    z.boolean(),
    z.instanceof(KExaone2HistoryNumber),
    z.array(kExaone236BJsonValueSchema),
    z.record(z.string(), kExaone236BJsonValueSchema),
  ])
);

function normalizeRelaxedJsonQuotes(text: string): string {
  let normalized = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      if (quote === "'" && character === "'") {
        normalized = `${normalized.slice(0, -1)}'`;
      } else {
        normalized += character;
      }
      escaped = false;
      continue;
    }
    if (character === "\\") {
      normalized += character;
      escaped = true;
      continue;
    }
    if (quote === null && (character === "'" || character === '"')) {
      quote = character;
      normalized += '"';
      continue;
    }
    if (character === quote) {
      quote = null;
      normalized += '"';
      continue;
    }
    if (quote === "'" && character === '"') {
      normalized += '\\"';
      continue;
    }
    normalized += character;
  }
  return normalized;
}

function canonicalizeParametersAlias(toolCallJson: string): string {
  const normalizedEnvelope = normalizeRelaxedJsonQuotes(
    normalizeJsonStringCtrl(toolCallJson)
  ).replace(TRAILING_COMMA_REGEX, "$1");
  if (ARGUMENTS_FIELD_REGEX.test(normalizedEnvelope)) {
    return normalizedEnvelope;
  }
  return normalizedEnvelope.replace(PARAMETERS_FIELD_REGEX, '$1"arguments":');
}

function stringifyKExaone236BJson(
  value: KExaone236BJsonValue | undefined,
  compact: boolean
): string {
  if (value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    const separator = compact ? "," : ", ";
    return `[${value
      .map((item) => stringifyKExaone236BJson(item, compact))
      .join(separator)}]`;
  }
  if (typeof value === "object" && value !== null) {
    if (value instanceof KExaone2HistoryNumber) {
      return compact
        ? stringifyKExaone2CompactJson(value)
        : stringifyKExaone2NativeJson(value);
    }
    const comma = compact ? "," : ", ";
    const colon = compact ? ":" : ": ";
    return `{${Object.entries(value)
      .map(
        ([key, property]) =>
          `${JSON.stringify(decodeKExaone2HistoryKey(key))}${colon}${stringifyKExaone236BJson(property, compact)}`
      )
      .join(comma)}}`;
  }
  return compact
    ? stringifyKExaone2CompactJson(value)
    : stringifyKExaone2NativeJson(value);
}

function overlayLosslessNumbers(
  rawValue: KExaone236BJsonValue | undefined,
  validatedValue: JSONValue | undefined
): string {
  if (
    rawValue instanceof KExaone2HistoryNumber &&
    typeof validatedValue === "number"
  ) {
    return stringifyKExaone236BJson(rawValue, true);
  }
  if (Array.isArray(rawValue) && Array.isArray(validatedValue)) {
    return `[${validatedValue
      .map((value, index) => overlayLosslessNumbers(rawValue[index], value))
      .join(",")}]`;
  }
  if (
    typeof rawValue === "object" &&
    rawValue !== null &&
    !Array.isArray(rawValue) &&
    typeof validatedValue === "object" &&
    validatedValue !== null &&
    !Array.isArray(validatedValue)
  ) {
    const rawEntries = new Map(
      Object.entries(rawValue).map(([key, value]) => [
        decodeKExaone2HistoryKey(key),
        value,
      ])
    );
    return `{${Object.entries(validatedValue)
      .filter((entry): entry is [string, JSONValue] => entry[1] !== undefined)
      .map(
        ([key, value]) =>
          `${JSON.stringify(key)}:${overlayLosslessNumbers(
            rawEntries.get(key) ??
              [...rawEntries.entries()].find(
                ([rawKey]) =>
                  rawKey.replaceAll("_", "").toLowerCase() ===
                  key.replaceAll("_", "").toLowerCase()
              )?.[1],
            value
          )}`
      )
      .join(",")}}`;
  }
  return stringifyKExaone236BJson(validatedValue, true);
}

function resolveKExaone236BToolCall(
  toolCallJson: string,
  tools: LanguageModelV4FunctionTool[]
): ResolvedProtocolToolCall {
  const canonicalToolCallJson = canonicalizeParametersAlias(toolCallJson);
  const normalizedToolCallJson = normalizeRelaxedJsonQuotes(
    normalizeJsonStringCtrl(canonicalToolCallJson)
  ).replace(TRAILING_COMMA_REGEX, "$1");
  const validated = resolveToolCall(normalizedToolCallJson, tools);
  if (!validated.ok) {
    return validated;
  }
  try {
    const progress = extractStreamingToolCallProgress(normalizedToolCallJson);
    if (!(progress.argumentsComplete && progress.argumentsText)) {
      return validated;
    }
    const validatedInput = JSON.parse(validated.input);
    if (!isJSONValue(validatedInput)) {
      return validated;
    }
    const normalizedArguments = normalizeRelaxedJsonQuotes(
      normalizeInvalidJsonEscapes(
        normalizeJsonStringCtrl(progress.argumentsText)
      )
    ).replace(TRAILING_COMMA_REGEX, "$1");
    const losslessInput = kExaone236BJsonValueSchema.parse(
      parseKExaone2LosslessJson(normalizedArguments)
    );
    return {
      ok: true,
      toolName: validated.toolName,
      input: overlayLosslessNumbers(losslessInput, validatedInput),
    };
  } catch {
    return validated;
  }
}

function formatKExaone236BToolCall(toolCall: LanguageModelV4ToolCall): string {
  const name = stringifyKExaone236BJson(toolCall.toolName, false);
  const args = stringifyKExaone236BJson(
    kExaone236BJsonValueSchema.parse(parseKExaoneToolCallInput(toolCall.input)),
    false
  );
  return `<tool_call>{"name": ${name}, "arguments": ${args}}</tool_call>`;
}

export const kExaone236BProtocol = (): TCMProtocol => {
  const protocol = hermesProtocol({
    resolveToolCall: resolveKExaone236BToolCall,
  });

  return {
    ...protocol,
    formatToolCall: formatKExaone236BToolCall,
  };
};
