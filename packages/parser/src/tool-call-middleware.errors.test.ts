import { describe, it, expect } from "vitest";
import { createToolMiddleware } from "./tool-call-middleware";
import { jsonMixProtocol } from "./protocols/json-mix-protocol";

describe("createToolMiddleware error branches", () => {
  const mw = createToolMiddleware({
    protocol: jsonMixProtocol,
    toolSystemPromptTemplate: t => `T:${t}`,
  });

  it("throws when toolChoice none is used", async () => {
    await expect(
      mw.transformParams!({
        params: { prompt: [], toolChoice: { type: "none" } },
      } as any)
    ).rejects.toThrow(/none/);
  });

  it("throws when specific tool not found", async () => {
    await expect(
      mw.transformParams!({
        params: {
          prompt: [],
          tools: [],
          toolChoice: { type: "tool", toolName: "missing" },
        },
      } as any)
    ).rejects.toThrow(/not found/);
  });

  it("throws when provider-defined tool is selected", async () => {
    await expect(
      mw.transformParams!({
        params: {
          prompt: [],
          tools: [{ type: "provider-defined", id: "x" } as any],
          toolChoice: { type: "tool", toolName: "x" },
        },
      } as any)
    ).rejects.toThrow(/Provider-defined tools/);
  });
});
