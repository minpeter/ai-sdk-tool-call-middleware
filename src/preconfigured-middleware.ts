import {
  formatToolResponseAsHermes,
  hermesSystemPromptTemplate,
} from "./core/prompts/hermes-prompt";
import {
  morphFormatToolResponseAsXml,
  morphXmlSystemPromptTemplate,
} from "./core/prompts/morph-xml-prompt";
import {
  formatToolResponseAsQwen3CoderXml,
  qwen3coderSystemPromptTemplate,
} from "./core/prompts/qwen3coder-prompt";
import {
  formatToolResponseAsYaml,
  yamlXmlSystemPromptTemplate,
} from "./core/prompts/yaml-xml-prompt";
import { hermesProtocol } from "./core/protocols/hermes-protocol";
import { morphXmlProtocol } from "./core/protocols/morph-xml-protocol";
import { qwen3CoderProtocol } from "./core/protocols/qwen3coder-protocol";
import { yamlXmlProtocol } from "./core/protocols/yaml-xml-protocol";
import { createToolMiddleware } from "./tool-call-middleware";

export const hermesToolMiddleware = createToolMiddleware({
  protocol: hermesProtocol(),
  toolSystemPromptTemplate: hermesSystemPromptTemplate,
  toolResponsePromptTemplate: formatToolResponseAsHermes,
});

export const qwen3CoderToolMiddleware = createToolMiddleware({
  protocol: qwen3CoderProtocol,
  toolSystemPromptTemplate: qwen3coderSystemPromptTemplate,
  toolResponsePromptTemplate: formatToolResponseAsQwen3CoderXml,
});

export const morphXmlToolMiddleware = createToolMiddleware({
  protocol: morphXmlProtocol({}),
  toolSystemPromptTemplate: morphXmlSystemPromptTemplate,
  toolResponsePromptTemplate: morphFormatToolResponseAsXml,
});

export const yamlXmlToolMiddleware = createToolMiddleware({
  protocol: yamlXmlProtocol({}),
  toolSystemPromptTemplate: yamlXmlSystemPromptTemplate,
  toolResponsePromptTemplate: formatToolResponseAsYaml,
});
