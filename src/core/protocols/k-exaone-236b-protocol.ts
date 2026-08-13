import type { LanguageModelV4ToolCall } from "@ai-sdk/provider";
import {
  decodeKExaone2HistoryKey,
  isKExaone2HistoryNumber,
  parseKExaone2LosslessJson,
} from "../prompts/k-exaone-2-lossless-json";
import {
  stringifyKExaone2CompactJson,
  stringifyKExaone2NativeJson,
} from "../prompts/k-exaone-2-native-json";
import { resolveToolCall } from "./hermes-call-parsing";
import { normalizeJsonStringCtrl } from "./hermes-json-normalization";
import { normalizeInvalidJsonEscapes } from "./hermes-json-repair";
import { hermesProtocol } from "./hermes-protocol";
import { extractStreamingToolCallProgress } from "./hermes-streaming-progress";
import { parseKExaoneToolCallInput } from "./k-exaone-tool-call-input";
import type { TCMProtocol } from "./protocol-interface";

const PARAMETERS_FIELD_REGEX = /([,{]\s*)(["'])parameters\2\s*:/;
const TRAILING_COMMA_REGEX = /,(\s*[}\]])/g;

function normalizeRelaxedJsonQuotes(text: string): string {
  let normalized = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of text) {
    if (escaped) {
      normalized += character;
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
    normalized += character;
  }
  return normalized;
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
  const canonicalToolCallJson = toolCallJson.replace(
    PARAMETERS_FIELD_REGEX,
    "$1$2arguments$2:"
  );
  const validated = resolveToolCall(canonicalToolCallJson, tools);
  if (!validated.ok) {
    return validated;
  }
  try {
    const progress = extractStreamingToolCallProgress(canonicalToolCallJson);
    if (!(progress.argumentsComplete && progress.argumentsText)) {
      return validated;
    }
    const validatedInput = JSON.parse(validated.input) as unknown;
    const normalizedArguments = normalizeRelaxedJsonQuotes(
      normalizeInvalidJsonEscapes(
        normalizeJsonStringCtrl(progress.argumentsText)
      )
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
