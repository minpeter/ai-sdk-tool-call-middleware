import type {
  LanguageModelV3Content,
  LanguageModelV3FunctionTool,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { coerceBySchema } from "../../schema-coerce";

type ToolCallLike = Extract<
  LanguageModelV3Content | LanguageModelV3StreamPart,
  { type: "tool-call" }
>;

export function coerceToolCallInput(
  toolName: string,
  input: unknown,
  tools: LanguageModelV3FunctionTool[]
): string | undefined {
  let args: unknown = {};
  if (typeof input === "string") {
    try {
      args = JSON.parse(input);
    } catch {
      return;
    }
  } else if (input && typeof input === "object") {
    args = input;
  } else {
    return;
  }

  const schema = tools.find((t) => t.name === toolName)?.inputSchema;
  const coerced = coerceBySchema(args, schema);
  return JSON.stringify(coerced ?? {});
}

export function coerceToolCallPart<T extends ToolCallLike>(
  part: T,
  tools: LanguageModelV3FunctionTool[]
): T {
  const coercedInput = coerceToolCallInput(part.toolName, part.input, tools);
  if (coercedInput === undefined) {
    return part;
  }

  return {
    ...part,
    input: coercedInput,
  };
}
