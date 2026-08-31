import type {
  LanguageModelV4CallOptions,
  LanguageModelV4FunctionTool,
} from "@ai-sdk/provider";
import {
  K_EXAONE_236B_TOOL_CALL_FORMAT,
  kExaone236BToolDeclaration,
} from "./core/prompts/k-exaone-236b-prompt";
import { kExaone236BProtocol } from "./core/protocols/k-exaone-236b-protocol";
import { transformParams } from "./transform-handler";

export function transformKExaone236BParams(
  params: LanguageModelV4CallOptions
): LanguageModelV4CallOptions {
  const functionTools = (params.tools ?? []).filter(
    (tool): tool is LanguageModelV4FunctionTool => tool.type === "function"
  );
  const baseParams = transformParams({
    params: {
      ...params,
      prompt: [],
    },
    protocol: kExaone236BProtocol(),
    toolSystemPromptTemplate: () => "",
  });

  if (params.toolChoice?.type === "none") {
    return {
      ...baseParams,
      prompt: params.prompt,
    };
  }

  const declaration = kExaone236BToolDeclaration(functionTools);
  if (declaration.length === 0) {
    return {
      ...baseParams,
      prompt: params.prompt,
    };
  }

  return {
    ...baseParams,
    prompt: [
      {
        role: "system",
        content: declaration,
        providerOptions: {
          openaiCompatible: {
            role: "tool_declare",
          },
        },
      },
      {
        role: "system",
        content: K_EXAONE_236B_TOOL_CALL_FORMAT,
      },
      ...params.prompt,
    ],
  };
}
