import { describe, expect, it, vi } from "vitest";

import { morphXmlProtocol } from "../../core/protocols/morph-xml-protocol";

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
  ] as any;

  it("parses tool-call even when a closing tag is split across lines (e.g. </\n  step>)", () => {
    const p = morphXmlProtocol();

    const text = `<update_plan><explanation>Using apply_patch to create AGENTS.md file with repository guidelines</explanation><plan><step><step>Analyze project
  structure and configuration files</step><status>completed</status><step><step>Create AGENTS.md file using apply_patch with comprehensive content</
  step><status>in_progress</status></step></plan></update_plan>`;

    const out = p.parseGeneratedText({ text, tools, options: {} });

    const toolParts = out.filter((c) => (c as any).type === "tool-call");
    expect(toolParts.length).toBe(1);

    const tc = toolParts[0] as any;
    expect(tc.toolName).toBe("update_plan");

    const args = JSON.parse(tc.input as string);

    expect(typeof args.explanation).toBe("string");
    expect(args.explanation).toContain("AGENTS.md");

    expect(args.plan).toBeTruthy();
    expect(Array.isArray(args.plan.step)).toBe(true);
    expect(args.plan.step.length).toBe(2);

    expect(args.plan.step[0].status).toBe("completed");
    expect(args.plan.step[0].step).toContain("Analyze project");
    expect(args.plan.step[0].step).toContain("configuration files");

    expect(args.plan.step[1].status).toBe("in_progress");
    expect(args.plan.step[1].step).toContain(
      "Create AGENTS.md file using apply_patch with comprehensive content"
    );
  });
});
