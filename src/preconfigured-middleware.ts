import { glm5SystemPromptTemplate } from "./core/prompts/glm5-prompt";
import {
  formatToolResponseAsHermes,
  hermesSystemPromptTemplate,
} from "./core/prompts/hermes-prompt";
import {
  formatToolResponseAsKExaone2,
  kExaone2SystemPromptTemplate,
} from "./core/prompts/k-exaone-2-prompt";
import { kExaone236BSystemPromptMessages } from "./core/prompts/k-exaone-236b-prompt";
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
import { glm5Protocol } from "./core/protocols/glm5/protocol";
import { hermesProtocol } from "./core/protocols/hermes/protocol";
import { kExaone2Protocol } from "./core/protocols/k-exaone/k-exaone-2-protocol";
import { kExaone236BProtocol } from "./core/protocols/k-exaone/k-exaone-236b-protocol";
import { morphXmlProtocol } from "./core/protocols/morph-xml/protocol";
import { qwen3CoderProtocol } from "./core/protocols/qwen3coder/protocol";
import { yamlXmlProtocol } from "./core/protocols/yaml-xml/protocol";
import { createToolMiddleware } from "./tool-call-middleware";

export const kExaone236BToolMiddleware = createToolMiddleware({
  protocol: kExaone236BProtocol(),
  promptStrategy: {
    mode: "messages",
    build: kExaone236BSystemPromptMessages,
  },
  historyStrategy: {
    mode: "provider-native",
  },
});

export const kExaone2ToolMiddleware = createToolMiddleware({
  protocol: kExaone2Protocol(),
  promptStrategy: {
    mode: "text",
    template: kExaone2SystemPromptTemplate,
    placement: "first",
  },
  historyStrategy: {
    mode: "converted-text",
    toolResponsePromptTemplate: formatToolResponseAsKExaone2,
  },
});

export const hermesToolMiddleware = createToolMiddleware({
  protocol: hermesProtocol(),
  promptStrategy: {
    mode: "text",
    template: hermesSystemPromptTemplate,
  },
  historyStrategy: {
    mode: "converted-text",
    toolResponsePromptTemplate: formatToolResponseAsHermes,
  },
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
  promptStrategy: {
    mode: "text",
    template: glm5SystemPromptTemplate,
    placement: "standalone-first",
    suppressForForcedChoice: true,
  },
  historyStrategy: {
    mode: "provider-native",
  },
});

export const qwen3CoderToolMiddleware = createToolMiddleware({
  protocol: qwen3CoderProtocol,
  promptStrategy: {
    mode: "text",
    template: qwen3coderSystemPromptTemplate,
  },
  historyStrategy: {
    mode: "converted-text",
    toolResponsePromptTemplate: formatToolResponseAsQwen3CoderXml,
  },
});

export const morphXmlToolMiddleware = createToolMiddleware({
  protocol: morphXmlProtocol({}),
  promptStrategy: {
    mode: "text",
    template: morphXmlSystemPromptTemplate,
  },
  historyStrategy: {
    mode: "converted-text",
    toolResponsePromptTemplate: morphFormatToolResponseAsXml,
  },
});

export const yamlXmlToolMiddleware = createToolMiddleware({
  protocol: yamlXmlProtocol({}),
  promptStrategy: {
    mode: "text",
    template: yamlXmlSystemPromptTemplate,
  },
  historyStrategy: {
    mode: "converted-text",
    toolResponsePromptTemplate: formatToolResponseAsYaml,
  },
});
