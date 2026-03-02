import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Middleware,
} from "@ai-sdk/provider";
import { morphXmlProtocol } from "../core/protocols/morph-xml-protocol";
import { createToolMiddleware } from "../tool-call-middleware";

/**
 * Minimal middleware preset used in docs/tests to prove the stack works.
 */
export function createHelloToolMiddleware({
  promptIntro = "Use <tool_call> tags when you must execute a tool.",
}: {
  promptIntro?: string;
} = {}): LanguageModelV3Middleware {
  const toolSystemPromptTemplate = (
    tools: LanguageModelV3FunctionTool[]
  ): string => {
    if (tools.length === 0) {
      return `${promptIntro} No tools are currently available.`;
    }

    const list = tools
      .map((tool) => `- ${tool.name}: ${tool.description ?? ""}`.trim())
      .join("\n");

    return `${promptIntro}\nList of tools:\n${list}`;
  };

  return createToolMiddleware({
    protocol: morphXmlProtocol,
    toolSystemPromptTemplate,
  });
}
