import {
  formatToolResponseAsQwen3CoderXml,
  qwen3coderSystemPromptTemplate,
} from "../core/prompts/qwen3coder-prompt";
import { qwen3coder_tool_parser } from "../core/protocols/qwen3coder-protocol";
import { createToolMiddleware } from "../tool-call-middleware";

export const qwen3CoderToolParserMiddleware = createToolMiddleware({
  protocol: qwen3coder_tool_parser,
  toolSystemPromptTemplate: qwen3coderSystemPromptTemplate,
  toolResponsePromptTemplate: formatToolResponseAsQwen3CoderXml,
});
