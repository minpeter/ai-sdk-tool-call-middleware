import type { LanguageModelV4Middleware } from "@ai-sdk/provider";
import {
  formatToolResponseAsGlm5,
  glm5SystemPromptTemplate,
} from "./core/prompts/glm5-prompt";
import {
  formatToolResponseAsHermes,
  hermesSystemPromptTemplate,
} from "./core/prompts/hermes-prompt";
import {
  formatToolResponseAsKExaone2,
  kExaone2SystemPromptTemplate,
} from "./core/prompts/k-exaone-2-prompt";
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
import { kExaone2Protocol } from "./core/protocols/k-exaone-2-protocol";
import { kExaone236BProtocol } from "./core/protocols/k-exaone-236b-protocol";
import { morphXmlProtocol } from "./core/protocols/morph-xml-protocol";
import { qwen3CoderProtocol } from "./core/protocols/qwen3coder-protocol";
import { yamlXmlProtocol } from "./core/protocols/yaml-xml-protocol";
import { wrapGenerate } from "./generate-handler";
import { transformKExaone236BParams } from "./k-exaone-236b-transform";
import { wrapStream } from "./stream-handler";
import { createToolMiddleware } from "./tool-call-middleware";

const kExaone236BProtocolInstance = kExaone236BProtocol();

export const kExaone236BToolMiddleware: LanguageModelV4Middleware = {
  specificationVersion: "v4",
  transformParams: async ({ params }) => transformKExaone236BParams(params),
  wrapGenerate: ({ doGenerate, params }) =>
    wrapGenerate({
      protocol: kExaone236BProtocolInstance,
      doGenerate,
      params,
    }),
  wrapStream: ({ doGenerate, doStream, params }) =>
    wrapStream({
      protocol: kExaone236BProtocolInstance,
      doGenerate,
      doStream,
      params,
    }),
};

export const kExaone2ToolMiddleware = createToolMiddleware({
  protocol: kExaone2Protocol(),
  toolSystemPromptTemplate: kExaone2SystemPromptTemplate,
  toolResponsePromptTemplate: formatToolResponseAsKExaone2,
  placement: "first",
});

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
