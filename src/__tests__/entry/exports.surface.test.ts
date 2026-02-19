import { describe, expect, it } from "vitest";

import {
  createToolMiddleware,
  hermesProtocol,
  hermesToolMiddleware,
  morphXmlToolMiddleware,
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

  it("creates custom middleware with v3 specification", () => {
    const customMiddleware = createToolMiddleware({
      protocol: hermesProtocol(),
      toolSystemPromptTemplate: (tools) =>
        `Custom template: ${JSON.stringify(tools)}`,
    });

    expect(customMiddleware).toBeDefined();
    expect(customMiddleware.specificationVersion).toBe("v3");
  });
});
