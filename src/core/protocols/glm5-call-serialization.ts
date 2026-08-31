import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { stringifyToolInputWithSchema } from "../utils/tool-input-streaming";
import type { ParsedGlm5Call } from "./glm5-call-types";

export function stringifyGlm5CallInput(
  call: Pick<ParsedGlm5Call, "args" | "toolName">,
  tools: LanguageModelV4FunctionTool[]
): string {
  return stringifyToolInputWithSchema({
    args: call.args,
    toolName: call.toolName,
    tools,
  });
}
