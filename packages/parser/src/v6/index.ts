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
import { createToolMiddleware } from "./tool-call-middleware";

export const gemmaToolMiddleware = createToolMiddleware({
  protocol: jsonMixProtocol({
    toolCallStart: "```tool_call\n",
    toolCallEnd: "\n```",
    toolResponseStart: "```tool_response\n",
    toolResponseEnd: "\n```",
  }),
  toolSystemPromptTemplate: gemmaSystemPromptTemplate,
});

export const hermesToolMiddleware = createToolMiddleware({
  protocol: jsonMixProtocol,
  toolSystemPromptTemplate: hermesSystemPromptTemplate,
});

export const morphXmlToolMiddleware = createToolMiddleware({
  protocol: morphXmlProtocol,
  placement: "first",
  toolSystemPromptTemplate: morphXmlSystemPromptTemplate,
});

export const orchestratorToolMiddleware = createToolMiddleware({
  protocol: yamlXmlProtocol(),
  placement: "first",
  toolSystemPromptTemplate: orchestratorSystemPromptTemplate,
});

export { createToolMiddleware } from "./tool-call-middleware";
