// biome-ignore-all lint/performance/noBarrelFile: intentional public API surface

import {
  hermesSystemPromptTemplate,
  xmlSystemPromptTemplate,
  yamlSystemPromptTemplate,
} from "../core/prompts";
import { jsonProtocol } from "../core/protocols/json-protocol";
import { xmlProtocol } from "../core/protocols/xml-protocol";
import { yamlProtocol } from "../core/protocols/yaml-protocol";
import { createToolMiddlewareV5 } from "./tool-call-middleware";

export const hermesToolMiddleware = createToolMiddlewareV5({
  protocol: jsonProtocol,
  toolSystemPromptTemplate: hermesSystemPromptTemplate,
});

export const xmlToolMiddleware = createToolMiddlewareV5({
  protocol: xmlProtocol,
  placement: "first",
  toolSystemPromptTemplate: xmlSystemPromptTemplate,
});

export const yamlToolMiddleware = createToolMiddlewareV5({
  protocol: yamlProtocol(),
  placement: "first",
  toolSystemPromptTemplate: yamlSystemPromptTemplate,
});

export { createToolMiddlewareV5 as createToolMiddleware } from "./tool-call-middleware";
