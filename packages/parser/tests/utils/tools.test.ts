import { describe, it, expect } from "vitest";
import { getFunctionTools, isToolChoiceActive } from "@/utils/tools";

describe("tools utils", () => {
  it("getFunctionTools returns filtered tools when no provider override", () => {
    const tools = [
      {
        type: "function",
        name: "a",
        description: "",
        inputSchema: { type: "object" },
      },
      { type: "provider-defined", id: "p" },
    ] as any;
    const result = getFunctionTools({ tools });
    expect(result).toEqual([
      {
        type: "function",
        name: "a",
        description: "",
        inputSchema: { type: "object" },
      },
    ]);
  });

  it("getFunctionTools uses providerOptions toolNames override when present", () => {
    const result = getFunctionTools({
      tools: [],
      providerOptions: { toolCallMiddleware: { toolNames: ["x", 1, "y"] } },
    } as any);
    expect(result).toEqual([
      {
        type: "function",
        name: "x",
        description: "",
        inputSchema: { type: "object" },
      },
      {
        type: "function",
        name: "y",
        description: "",
        inputSchema: { type: "object" },
      },
    ]);
  });

  it("isToolChoiceActive detects required and tool types", () => {
    expect(
      isToolChoiceActive({
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "required" } },
        },
      })
    ).toBe(true);
    expect(
      isToolChoiceActive({
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "tool" } },
        },
      })
    ).toBe(true);
    expect(
      isToolChoiceActive({
        providerOptions: {
          toolCallMiddleware: { toolChoice: { type: "none" } },
        },
      })
    ).toBe(false);
    expect(isToolChoiceActive({} as any)).toBe(false);
  });
});
