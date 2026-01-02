// biome-ignore-all lint/performance/noBarrelFile: intentional public API surface

import {
  gemmaSystemPromptTemplate,
  hermesSystemPromptTemplate,
  morphXmlSystemPromptTemplate,
  orchestratorSystemPromptTemplate,
} from "../core/prompts";
import { jsonMixProtocol } from "../core/protocols/json-mix-protocol";
import { morphXmlProtocol } from "../core/protocols/morph-xml-protocol";
import { yamlXmlProtocol } from "../core/protocols/yaml-xml-protocol";
import { createToolMiddlewareV5 } from "./tool-call-middleware";

export const gemmaToolMiddleware = createToolMiddlewareV5({
  protocol: jsonMixProtocol({
    toolCallStart: "```tool_call\n",
    toolCallEnd: "\n```",
    toolResponseStart: "```tool_response\n",
    toolResponseEnd: "\n```",
  }),
  toolSystemPromptTemplate: gemmaSystemPromptTemplate,
});

export const hermesToolMiddleware = createToolMiddlewareV5({
  protocol: jsonMixProtocol,
  toolSystemPromptTemplate: hermesSystemPromptTemplate,
});

export const morphXmlToolMiddleware = createToolMiddlewareV5({
  protocol: morphXmlProtocol,
  placement: "first",
  toolSystemPromptTemplate: morphXmlSystemPromptTemplate,
});

export const orchestratorToolMiddleware = createToolMiddlewareV5({
  protocol: yamlXmlProtocol(),
  placement: "first",
  toolSystemPromptTemplate: orchestratorSystemPromptTemplate,
});

export { createToolMiddlewareV5 as createToolMiddleware } from "./tool-call-middleware";
