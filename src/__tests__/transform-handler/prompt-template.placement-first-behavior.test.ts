import { describe, expect, it } from "vitest";
import { hermesProtocol } from "../../core/protocols/hermes-protocol";
import { createToolMiddleware } from "../../tool-call-middleware";
import { createOperationTools } from "../fixtures/function-tools";
import { requireTransformParams } from "../test-helpers";

describe("placement first behavior", () => {
  const tools = createOperationTools("d");

  it("placement=first prepends system message before user when no system exists", async () => {
    const mw = createToolMiddleware({
      protocol: hermesProtocol,
      toolSystemPromptTemplate: (t) => `TOOLS:${t}`,
      placement: "first",
    });

    const transformParams = requireTransformParams(mw.transformParams);
    const out = await transformParams({
      params: {
        prompt: [
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: "hello" }],
          },
        ],
        tools,
      },
    } as any);

    expect(out.prompt[0].role).toBe("system");
    expect(String(out.prompt[0].content)).toContain("TOOLS:");
  });
});
