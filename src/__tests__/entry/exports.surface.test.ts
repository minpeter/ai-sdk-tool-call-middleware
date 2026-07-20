import { describe, expect, it } from "vitest";

import {
  createGlm5ToolResponseFormatter,
  createHermesToolResponseFormatter,
  createMorphXmlToolResponseFormatter,
  createQwen3CoderXmlToolResponseFormatter,
  createToolMiddleware,
  createUserContentToolResponseTemplate,
  formatToolResponseAsYaml,
  glm5Protocol,
  glm5SystemPromptTemplate,
  glm5ToolMiddleware,
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

  it("exports the GLM-5.2 protocol, prompt, formatter, and middleware", () => {
    expect(typeof glm5Protocol).toBe("function");
    expect(typeof glm5SystemPromptTemplate).toBe("function");
    expect(typeof createGlm5ToolResponseFormatter).toBe("function");
    expect(glm5ToolMiddleware).toBeDefined();
    expect(glm5ToolMiddleware.specificationVersion).toBe("v4");
  });

  it("does not expose a provider-native GLM transport", async () => {
    // Given: the package's runtime entry surface.
    const forbiddenExports = [
      "createGlm5NativePlusMiddleware",
      "glm5NativePlusSystemPromptTemplate",
      "glm5NativePlusToolMiddleware",
    ];
    const packageEntry = await import("../../index");

    // When: provider-native GLM symbols are selected from that surface.
    const exposedForbiddenExports = forbiddenExports.filter(
      (name) => name in packageEntry
    );

    // Then: no bypass around prompt-only transport is public.
    expect(exposedForbiddenExports).toEqual([]);
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
