import {
  isJSONObject,
  isJSONValue,
  type JSONArray,
  type JSONObject,
  type JSONValue,
} from "@ai-sdk/provider";

export type KExaoneRequestBody = JSONObject & {
  readonly messages: JSONArray;
};

export function parseKExaoneRequestBody(source: string): KExaoneRequestBody {
  if (typeof source !== "string") {
    throw new TypeError("Expected a JSON request body");
  }
  const candidate: JSONValue = JSON.parse(source);
  if (!isJSONValue(candidate)) {
    throw new TypeError("Expected a K-EXAONE request body");
  }
  if (!isJSONObject(candidate)) {
    throw new TypeError("Expected a K-EXAONE request body");
  }
  const { messages } = candidate;
  if (!Array.isArray(messages)) {
    throw new TypeError("Expected a K-EXAONE request body");
  }
  return { ...candidate, messages };
}
