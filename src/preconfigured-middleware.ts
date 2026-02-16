import {
  formatToolResponseAsJsonInXml,
  hermesSystemPromptTemplate,
} from "./core/prompts/hermes-prompt";
import {
  formatToolResponseAsXml,
  xmlSystemPromptTemplate,
} from "./core/prompts/xml-prompt";
import {
  formatToolResponseAsYaml,
  yamlSystemPromptTemplate,
} from "./core/prompts/yaml-prompt";
import { jsonProtocol } from "./core/protocols/json-protocol";
import { xmlProtocol } from "./core/protocols/xml-protocol";
import { yamlProtocol } from "./core/protocols/yaml-protocol";
import { createToolMiddleware } from "./tool-call-middleware";

export const hermesToolMiddleware = createToolMiddleware({
  protocol: jsonProtocol({}),
  toolSystemPromptTemplate: hermesSystemPromptTemplate,
  toolResponsePromptTemplate: formatToolResponseAsJsonInXml,
});

export const xmlToolMiddleware = createToolMiddleware({
  protocol: xmlProtocol({}),
  toolSystemPromptTemplate: xmlSystemPromptTemplate,
  toolResponsePromptTemplate: formatToolResponseAsXml,
});

export const yamlToolMiddleware = createToolMiddleware({
  protocol: yamlProtocol({}),
  toolSystemPromptTemplate: yamlSystemPromptTemplate,
  toolResponsePromptTemplate: formatToolResponseAsYaml,
});
