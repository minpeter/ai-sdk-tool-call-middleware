// biome-ignore-all lint/performance/noBarrelFile: intentional public API surface

import {
  hermesSystemPromptTemplate,
  xmlSystemPromptTemplate,
  ymlSystemPromptTemplate,
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

export const ymlToolMiddleware = createToolMiddleware({
  protocol: yamlProtocol(),
  placement: "first",
  toolSystemPromptTemplate: ymlSystemPromptTemplate,
});

export { createToolMiddleware } from "./tool-call-middleware";
