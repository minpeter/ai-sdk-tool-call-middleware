import type { LanguageModelV4ToolCall } from "@ai-sdk/provider";
import {
  decodeKExaone2HistoryKey,
  isKExaone2HistoryNumber,
  parseKExaone2LosslessJson,
} from "../utils/codecs/k-exaone-2-lossless-json";
import {
  stringifyKExaone2CompactJson,
  stringifyKExaone2NativeJson,
} from "../utils/codecs/k-exaone-2-native-json";
import {
  extractNormalizedHermesArgumentsJson,
  normalizeHermesJsonControls,
  resolveToolCall,
} from "./hermes-call-parsing";
import { hermesProtocol } from "./hermes-protocol";
import { parseKExaoneToolCallInput } from "./k-exaone-tool-call-input";
import type { TCMProtocol } from "./protocol-interface";

const TRAILING_COMMA_REGEX = /,(\s*[}\]])/g;
const ARGUMENTS_FIELD_REGEX = /([,{]\s*)(["'])arguments\2\s*:/;
const PARAMETERS_FIELD_REGEX = /([,{]\s*)(["'])parameters\2\s*:/;

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
    normalizeHermesJsonControls(toolCallJson)
  ).replace(TRAILING_COMMA_REGEX, "$1");
  if (ARGUMENTS_FIELD_REGEX.test(normalizedEnvelope)) {
    return normalizedEnvelope;
  }
  return normalizedEnvelope.replace(PARAMETERS_FIELD_REGEX, '$1"arguments":');
}

function overlayLosslessNumbers(
  rawValue: unknown,
  validatedValue: unknown
): unknown {
  if (isKExaone2HistoryNumber(rawValue) && typeof validatedValue === "number") {
    return rawValue;
  }
  if (Array.isArray(rawValue) && Array.isArray(validatedValue)) {
    return validatedValue.map((value, index) =>
      overlayLosslessNumbers(rawValue[index], value)
    );
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
    return Object.fromEntries(
      Object.entries(validatedValue).map(([key, value]) => [
        key,
        overlayLosslessNumbers(
          rawEntries.get(key) ??
            [...rawEntries.entries()].find(
              ([rawKey]) =>
                rawKey.replaceAll("_", "").toLowerCase() ===
                key.replaceAll("_", "").toLowerCase()
            )?.[1],
          value
        ),
      ])
    );
  }
  return validatedValue;
}

function resolveKExaone236BToolCall(
  toolCallJson: string,
  tools: Parameters<typeof resolveToolCall>[1]
): ReturnType<typeof resolveToolCall> {
  const canonicalToolCallJson = canonicalizeParametersAlias(toolCallJson);
  const normalizedToolCallJson = normalizeRelaxedJsonQuotes(
    normalizeHermesJsonControls(canonicalToolCallJson)
  ).replace(TRAILING_COMMA_REGEX, "$1");
  const validated = resolveToolCall(normalizedToolCallJson, tools);
  if (!validated.ok) {
    return validated;
  }
  try {
    const rawArgumentsJson = extractNormalizedHermesArgumentsJson(
      normalizedToolCallJson
    );
    if (!rawArgumentsJson) {
      return validated;
    }
    const validatedInput = JSON.parse(validated.input) as unknown;
    const normalizedArguments = normalizeRelaxedJsonQuotes(
      rawArgumentsJson
    ).replace(TRAILING_COMMA_REGEX, "$1");
    const losslessInput = parseKExaone2LosslessJson(normalizedArguments);
    return {
      ok: true,
      toolName: validated.toolName,
      input: stringifyKExaone2CompactJson(
        overlayLosslessNumbers(losslessInput, validatedInput)
      ),
    };
  } catch {
    return validated;
  }
}

function formatKExaone236BToolCall(toolCall: LanguageModelV4ToolCall): string {
  return `<tool_call>${stringifyKExaone2NativeJson({
    name: toolCall.toolName,
    arguments: parseKExaoneToolCallInput(toolCall.input),
  })}</tool_call>`;
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

export const KExaone236BToolParser = kExaone236BProtocol;
