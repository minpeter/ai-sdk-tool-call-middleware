import { describe, it, expect } from "vitest";
import { getFunctionTools } from "@/utils/tools";

describe("getFunctionTools respects providerOptions.toolCallMiddleware.toolNames", () => {
  it("builds function tool stubs from string toolNames and ignores non-strings when no full tools provided", () => {
    const tools = getFunctionTools({
      tools: [],
      providerOptions: {
        toolCallMiddleware: { toolNames: ["x", 1, null] as any },
      },
    });
    expect(tools.map(t => t.name)).toEqual(["x"]);
  });
});
