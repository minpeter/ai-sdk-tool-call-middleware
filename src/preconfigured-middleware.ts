import { hermesSystemPromptTemplate } from "./core/prompts/hermes-system-prompt";
import {
  formatToolResponseAsJsonInXml,
  formatToolResponseAsXml,
} from "./core/prompts/tool-response";
import { xmlSystemPromptTemplate } from "./core/prompts/xml-system-prompt";
import { yamlSystemPromptTemplate } from "./core/prompts/yaml-system-prompt";
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
  toolResponsePromptTemplate: formatToolResponseAsXml,
});
