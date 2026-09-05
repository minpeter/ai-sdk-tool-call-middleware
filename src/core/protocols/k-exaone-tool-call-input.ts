import { parseKExaone2LosslessJson } from "../prompts/k-exaone-2-lossless-json";
import { KExaone2HistoryNumber } from "../prompts/k-exaone-2-lossless-json-tokens";
import type { KExaone2Value } from "../prompts/k-exaone-2-native-json";
import { KExaone2SerializationError } from "../prompts/k-exaone-2-serialization-error";

export type KExaoneToolCallInput =
  | null
  | string
  | number
  | boolean
  | KExaone2HistoryNumber
  | KExaoneToolCallInput[]
  | { readonly [key: string]: KExaoneToolCallInput };

function isKExaoneToolCallInput(
  value: KExaone2Value
): value is KExaoneToolCallInput {
  if (value instanceof KExaone2HistoryNumber) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isKExaoneToolCallInput);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).every(
      (entry) => entry !== undefined && isKExaoneToolCallInput(entry)
    );
  }
  return true;
}

export function parseKExaoneToolCallInput(
  input: string | null | undefined
): KExaoneToolCallInput {
  if (input == null) {
    return {};
  }

  try {
    const parsed = parseKExaone2LosslessJson(input);
    return isKExaoneToolCallInput(parsed) ? parsed : input;
  } catch (error) {
    if (error instanceof KExaone2SerializationError) {
      throw error;
    }
    return input;
  }
}
