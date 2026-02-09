import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { recoverToolCallFromJsonCandidates } from "../../core/utils/generated-text-json-recovery";

const tools: LanguageModelV3FunctionTool[] = [
  {
    type: "function",
    name: "calc",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number" },
      },
    },
  },
  {
    type: "function",
    name: "get_weather",
    inputSchema: {
      type: "object",
      properties: {
        city: { type: "string" },
      },
    },
  },
];

describe("recoverToolCallFromJsonCandidates", () => {
  it("prefers earliest JSON candidate when multiple are present", () => {
    const text =
      "before {\"name\":\"calc\",\"arguments\":{\"a\":1}} middle\n" +
      "```json\n" +
      "{\"name\":\"calc\",\"arguments\":{\"a\":2}}\n" +
      "``` after";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    expect(recovered).not.toBeNull();
    const tool = recovered?.find((part) => part.type === "tool-call") as any;

    expect(tool.toolName).toBe("calc");
    expect(JSON.parse(tool.input)).toEqual({ a: 1 });

    const textOut = recovered
      ?.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(textOut).toContain("before ");
    expect(textOut).toContain(" middle");
    expect(textOut).toContain("```json");
    expect(textOut).toContain("``` after");
  });

  it("does not recover nested tool payload objects", () => {
    const text =
      "before {\"tool\":{\"name\":\"get_weather\",\"arguments\":{\"city\":\"NYC\"}}} after";

    const recovered = recoverToolCallFromJsonCandidates(text, tools);

    expect(recovered).toBeNull();
  });
});
