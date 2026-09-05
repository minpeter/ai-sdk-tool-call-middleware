import {
  isJSONObject,
  type JSONObject,
  type JSONSchema7Definition,
  type LanguageModelV4Content,
  type LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import type { ParserOptions } from "../../../../core/protocols/protocol-interface";
import { yamlXmlProtocol } from "../../../../core/protocols/yaml-xml-protocol";
import { parse as parseRJSON } from "../../../../rjson";
import { runGeneratedJsonRepair } from "../../shared/duplicate-harness";

type GeneratedToolCall = Extract<LanguageModelV4Content, { type: "tool-call" }>;
type GeneratedText = Extract<LanguageModelV4Content, { type: "text" }>;

function objectTool(
  name: string,
  description: string,
  properties: Record<string, JSONSchema7Definition>,
  required: string[] = []
): LanguageModelV4FunctionTool {
  return {
    type: "function",
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length === 0 ? {} : { required }),
    },
  };
}

export const basicTools: LanguageModelV4FunctionTool[] = [
  objectTool(
    "get_weather",
    "Get the weather for a location",
    {
      location: { type: "string" },
      unit: { type: "string", enum: ["celsius", "fahrenheit"] },
    },
    ["location"]
  ),
  objectTool("get_location", "Get the current location", {}),
];

export const fileTools: LanguageModelV4FunctionTool[] = [
  objectTool(
    "write_file",
    "Write content to a file",
    {
      file_path: { type: "string" },
      contents: { type: "string" },
    },
    ["file_path", "contents"]
  ),
  objectTool(
    "read_file",
    "Read content from a file",
    {
      file_path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
    },
    ["file_path"]
  ),
];

export function parseYamlGenerated(
  text: string,
  tools: LanguageModelV4FunctionTool[],
  parserOptions?: ParserOptions
): LanguageModelV4Content[] {
  return runGeneratedJsonRepair({
    text,
    tools,
    protocol: yamlXmlProtocol(),
    parserOptions,
  });
}

export function selectGeneratedToolCalls(
  content: readonly LanguageModelV4Content[]
): GeneratedToolCall[] {
  return content.filter(
    (part): part is GeneratedToolCall => part.type === "tool-call"
  );
}

export function requireGeneratedToolCall(
  content: readonly LanguageModelV4Content[]
): GeneratedToolCall {
  const [toolCall] = selectGeneratedToolCalls(content);
  if (toolCall === undefined) {
    throw new TypeError("Expected generated tool-call part");
  }
  return toolCall;
}

export function parseGeneratedToolInput(
  toolCall: GeneratedToolCall
): JSONObject {
  const input = parseRJSON(toolCall.input, {
    duplicate: false,
    relaxed: false,
    tolerant: false,
  });
  if (!isJSONObject(input) || Array.isArray(input)) {
    throw new TypeError("Expected generated tool-call input object");
  }
  return input;
}

export function collectGeneratedText(
  content: readonly LanguageModelV4Content[]
): string {
  return content
    .filter((part): part is GeneratedText => part.type === "text")
    .map((part) => part.text)
    .join("");
}
