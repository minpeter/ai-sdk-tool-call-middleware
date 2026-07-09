import { describe, expect, it } from "vitest";

import {
  createHermesToolResponseFormatter,
  createMorphXmlToolResponseFormatter,
  createQwen3CoderXmlToolResponseFormatter,
  createToolMiddleware,
  createUserContentToolResponseTemplate,
  formatToolResponseAsYaml,
  hermesProtocol,
  hermesSystemPromptTemplate,
  hermesToolMiddleware,
  morphXmlSystemPromptTemplate,
  morphXmlToolMiddleware,
  qwen3coderSystemPromptTemplate,
  yamlXmlSystemPromptTemplate,
} from "../../index";

describe("entry exports surface", () => {
  it("exports hermesToolMiddleware", () => {
    expect(hermesToolMiddleware).toBeDefined();
  });

  it("exports morphXmlToolMiddleware", () => {
    expect(morphXmlToolMiddleware).toBeDefined();
  });

  it("exports hermesProtocol", () => {
    expect(hermesProtocol).toBeDefined();
  });

  it("exports createToolMiddleware as callable function", () => {
    expect(createToolMiddleware).toBeDefined();
    expect(typeof createToolMiddleware).toBe("function");
  });

  it("exports tool-response formatter factories and system prompts", () => {
    expect(typeof createHermesToolResponseFormatter).toBe("function");
    expect(typeof createMorphXmlToolResponseFormatter).toBe("function");
    expect(typeof createQwen3CoderXmlToolResponseFormatter).toBe("function");
    expect(typeof createUserContentToolResponseTemplate).toBe("function");
    expect(typeof formatToolResponseAsYaml).toBe("function");
    expect(typeof hermesSystemPromptTemplate).toBe("function");
    expect(typeof morphXmlSystemPromptTemplate).toBe("function");
    expect(typeof qwen3coderSystemPromptTemplate).toBe("function");
    expect(typeof yamlXmlSystemPromptTemplate).toBe("function");
  });

  it("creates custom middleware with v3 specification", () => {
    const customMiddleware = createToolMiddleware({
      protocol: hermesProtocol(),
      toolSystemPromptTemplate: (tools) =>
        `Custom template: ${JSON.stringify(tools)}`,
    });

    expect(customMiddleware).toBeDefined();
    expect(customMiddleware.specificationVersion).toBe("v4");
  });
});
