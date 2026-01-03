import { hermesSystemPromptTemplate } from "./core/prompts/hermes-system-prompt";
import { xmlSystemPromptTemplate } from "./core/prompts/xml-system-prompt";
import { jsonProtocol } from "./core/protocols/json-protocol";
import { xmlProtocol } from "./core/protocols/xml-protocol";
import { createToolMiddleware } from "./tool-call-middleware";

export const hermesToolMiddleware = createToolMiddleware({
  protocol: jsonProtocol({}),
  toolSystemPromptTemplate: hermesSystemPromptTemplate,
});

export const xmlToolMiddleware = createToolMiddleware({
  protocol: xmlProtocol({}),
  toolSystemPromptTemplate: xmlSystemPromptTemplate,
});
