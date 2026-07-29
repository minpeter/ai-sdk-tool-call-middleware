import {
  formatToolResponseAsGlm5,
  glm5SystemPromptTemplate,
} from "./core/prompts/glm5-prompt";
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
import { glm5Protocol } from "./core/protocols/glm5-protocol";
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

/**
 * GLM-5.2 adapter aligned with the model's pinned Hugging Face chat template.
 * Tool history stays structured so the provider template can render native
 * assistant/observation turns. Automatic selection uses the official tool
 * catalog as a distinct leading system turn; forced selection omits that XML
 * instruction because the middleware requests a JSON response format instead.
 */
export const glm5ToolMiddleware = createToolMiddleware({
  protocol: glm5Protocol(),
  toolSystemPromptTemplate: glm5SystemPromptTemplate,
  toolResponsePromptTemplate: formatToolResponseAsGlm5,
  placement: "standalone-first",
  historyMode: "provider-native",
  suppressToolSystemPromptForForcedChoice: true,
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
