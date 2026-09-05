import type { JSONValue, LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";
import { isStrictJSONObject } from "../../../test-helpers";

vi.spyOn(console, "warn").mockImplementation(() => {
  // suppress console warnings in tests
});

describe("morphXmlProtocol parseGeneratedText: lenient close tag normalization", () => {
  const tools = [
    {
      type: "function",
      name: "update_plan",
      description: "",
      inputSchema: {
        type: "object",
        properties: {
          explanation: { type: "string" },
          plan: {
            type: "object",
            properties: {
              step: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    step: { type: "string" },
                    status: { type: "string" },
                  },
                  required: ["step", "status"],
                  additionalProperties: true,
                },
              },
            },
            required: ["step"],
            additionalProperties: true,
          },
        },
        required: ["explanation", "plan"],
        additionalProperties: true,
      },
    },
  ] satisfies LanguageModelV4FunctionTool[];

  it("parses tool-call even when a closing tag is split across lines (e.g. </\n  step>)", () => {
    expect(isStrictJSONObject([])).toBe(false);
    expect(isStrictJSONObject({})).toBe(true);

    const p = morphXmlProtocol();

    const text = `<update_plan><explanation>Using apply_patch to create AGENTS.md file with repository guidelines</explanation><plan><step><step>Analyze project
  structure and configuration files</step><status>completed</status><step><step>Create AGENTS.md file using apply_patch with comprehensive content</
  step><status>in_progress</status></step></plan></update_plan>`;

    const out = p.parseGeneratedText({ text, tools, options: {} });

    const toolParts = out.filter((part) => part.type === "tool-call");
    expect(toolParts.length).toBe(1);

    const [toolCall] = toolParts;
    if (toolCall === undefined) {
      throw new TypeError("Expected one tool-call part");
    }
    expect(toolCall.toolName).toBe("update_plan");

    const parsedArgs: JSONValue = JSON.parse(toolCall.input);
    if (!isStrictJSONObject(parsedArgs)) {
      throw new TypeError("Expected tool-call input to be a JSON object");
    }

    const { explanation, plan } = parsedArgs;
    expect(typeof explanation).toBe("string");
    if (typeof explanation !== "string") {
      throw new TypeError("Expected an explanation string");
    }
    expect(explanation).toContain("AGENTS.md");

    expect(plan).toBeTruthy();
    if (!isStrictJSONObject(plan)) {
      throw new TypeError("Expected a plan object");
    }
    expect(Array.isArray(plan.step)).toBe(true);
    const steps = plan.step;
    if (!Array.isArray(steps)) {
      throw new TypeError("Expected an array of plan steps");
    }
    expect(steps.length).toBe(2);

    const [firstStep, secondStep] = steps;
    if (!(isStrictJSONObject(firstStep) && isStrictJSONObject(secondStep))) {
      throw new TypeError("Expected object-valued plan steps");
    }
    expect(firstStep.status).toBe("completed");
    expect(firstStep.step).toContain("Analyze project");
    expect(firstStep.step).toContain("configuration files");

    expect(secondStep.status).toBe("in_progress");
    expect(secondStep.step).toContain(
      "Create AGENTS.md file using apply_patch with comprehensive content"
    );
  });
});
