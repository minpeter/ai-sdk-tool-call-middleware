import { describe, expect, it } from "vitest";

import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";

describe("createToolMiddleware lifecycle", () => {
  const mockToolSystemPromptTemplate = (tools: unknown[]) =>
    `You have tools: ${JSON.stringify(tools)}`;

  it("creates middleware with required v3 hooks", () => {
    const middleware = createToolMiddleware({
      protocol: hermesProtocol({}),
      toolSystemPromptTemplate: mockToolSystemPromptTemplate,
    });

    expect(middleware).toBeDefined();
    expect(middleware.specificationVersion).toBe("v3");
    expect(middleware.wrapGenerate).toBeDefined();
    expect(middleware.wrapStream).toBeDefined();
    expect(middleware.transformParams).toBeDefined();
  });
});
