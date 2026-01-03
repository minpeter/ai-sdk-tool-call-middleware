// biome-ignore-all lint/performance/noBarrelFile: intentional public API surface

import {
  hermesSystemPromptTemplate,
  xmlSystemPromptTemplate,
  yamlSystemPromptTemplate,
} from "../core/prompts";
import { jsonProtocol } from "../core/protocols/json-protocol";
import { xmlProtocol } from "../core/protocols/xml-protocol";
import { yamlProtocol } from "../core/protocols/yaml-protocol";
import { createToolMiddleware } from "./tool-call-middleware";

export const hermesToolMiddleware = createToolMiddleware({
  protocol: jsonProtocol,
  toolSystemPromptTemplate: hermesSystemPromptTemplate,
});

export const xmlToolMiddleware = createToolMiddleware({
  protocol: xmlProtocol,
  placement: "first",
  toolSystemPromptTemplate: xmlSystemPromptTemplate,
});

export const yamlToolMiddleware = createToolMiddleware({
  protocol: yamlProtocol(),
  placement: "first",
  toolSystemPromptTemplate: yamlSystemPromptTemplate,
});

export { createToolMiddleware } from "./tool-call-middleware";
