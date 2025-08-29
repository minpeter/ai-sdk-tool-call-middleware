import { describe, it, expect } from "vitest";
import { getFunctionTools } from "@/utils/tools";

describe("getFunctionTools fallback behavior", () => {
  it("returns original function tools when providerOptions.toolNames absent/invalid", () => {
    const tools = getFunctionTools({
      tools: [
        {
          type: "function",
          name: "echo",
          description: "",
          inputSchema: { type: "object" },
        },
      ] as any,
      providerOptions: { toolCallMiddleware: { toolNames: undefined as any } },
    });
    expect(tools.map(t => t.name)).toEqual(["echo"]);
  });
});
