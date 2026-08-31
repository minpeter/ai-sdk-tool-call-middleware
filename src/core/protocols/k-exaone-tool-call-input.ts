import { parseKExaone2LosslessJson } from "../prompts/k-exaone-2-lossless-json";
import { KExaone2SerializationError } from "../prompts/k-exaone-2-serialization-error";

export function parseKExaoneToolCallInput(
  input: string | null | undefined
): unknown {
  if (input == null) {
    return {};
  }

  try {
    return parseKExaone2LosslessJson(input);
  } catch (error) {
    if (error instanceof KExaone2SerializationError) {
      throw error;
    }
    return input;
  }
}
