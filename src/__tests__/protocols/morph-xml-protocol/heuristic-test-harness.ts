import {
  isJSONObject,
  type JSONObject,
  type JSONSchema7Definition,
  type JSONValue,
  type LanguageModelV4Content,
  type LanguageModelV4FunctionTool,
  type LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { expect } from "vitest";
import { morphXmlProtocol } from "../../../core/protocols/morph-xml-protocol";
import {
  collectProtocolStream,
  runGeneratedJsonRepair,
} from "../shared/duplicate-harness";

export function morphObjectTool(
  name: string,
  properties: Record<string, JSONSchema7Definition>
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    inputSchema: { type: "object", properties },
  };
}

export function morphArrayTool(
  name: string,
  property: string,
  itemType: "number" | "string"
): LanguageModelV4FunctionTool {
  return morphObjectTool(name, {
    [property]: { type: "array", items: { type: itemType } },
  });
}

export function expectGeneratedMorphInput<Input = JSONObject>(
  text: string,
  tools: LanguageModelV4FunctionTool[]
): Input {
  const result = runGeneratedJsonRepair({
    protocol: morphXmlProtocol(),
    text,
    tools,
  });

  expect(result).toHaveLength(1);
  expect(result[0]?.type).toBe("tool-call");
  const call = result[0] as Extract<
    LanguageModelV4Content,
    { type: "tool-call" }
  >;
  const input: JSONValue = JSON.parse(call.input);
  if (!isJSONObject(input)) {
    throw new TypeError("Expected object-valued morph XML tool input");
  }
  return input as Input;
}

export function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    chunks.push(text.slice(offset, offset + size));
  }
  return chunks;
}

export function streamMorphText(
  text: string,
  tools: LanguageModelV4FunctionTool[],
  chunkSize = 10
): Promise<LanguageModelV4StreamPart[]> {
  const parts = chunkText(text, chunkSize).map(
    (delta): LanguageModelV4StreamPart => ({
      type: "text-delta",
      id: "fixture-text",
      delta,
    })
  );
  return collectProtocolStream({
    parts,
    protocol: morphXmlProtocol(),
    tools,
  });
}
