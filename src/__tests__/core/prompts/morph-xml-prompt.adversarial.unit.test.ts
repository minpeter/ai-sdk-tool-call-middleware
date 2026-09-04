import type { LanguageModelV4FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlSystemPromptTemplate } from "../../../core/prompts/morph-xml-prompt";
import type {
  ToolInputSchema,
  ToolInputSchemaCandidate,
} from "../../../schema/tool-input-schema";

describe("morphXmlSystemPromptTemplate adversarial runtime schemas", () => {
  it("summarizes a malformed primitive property schema", () => {
    const properties: NonNullable<ToolInputSchema["properties"]> = {
      malformed: {},
    };
    const malformedProperty: ToolInputSchemaCandidate = 23;
    Object.defineProperty(properties, "malformed", {
      enumerable: true,
      value: malformedProperty,
    });
    const tool: LanguageModelV4FunctionTool = {
      type: "function",
      name: "malformed_property",
      inputSchema: { type: "object", properties },
    };

    const prompt = morphXmlSystemPromptTemplate([tool]);

    expect(prompt).toContain("- malformed (23, optional)");
  });

  it("handles an enum whose mapper produces an absent inferred type", () => {
    const values: ToolInputSchemaCandidate = ["original"];
    Object.defineProperty(values, "map", {
      value: () => [undefined],
    });
    const valueSchema: ToolInputSchema = {};
    Object.defineProperty(valueSchema, "enum", {
      enumerable: true,
      value: values,
    });
    const tool: LanguageModelV4FunctionTool = {
      type: "function",
      name: "adversarial_enum",
      inputSchema: {
        type: "object",
        properties: { value: valueSchema },
      },
    };

    const prompt = morphXmlSystemPromptTemplate([tool]);

    expect(prompt).toContain("- value (, optional) - enum: []");
  });

  it("uses the empty-summary fallback when property iteration yields nothing", () => {
    const originalIterator = Array.prototype[Symbol.iterator];
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true,
      *value(this: unknown[]) {
        if (this.length === 1 && this[0] === "uniterable_property") {
          return;
        }
        yield* originalIterator.call(this);
      },
    });
    const tool: LanguageModelV4FunctionTool = {
      type: "function",
      name: "uniterable_properties",
      inputSchema: {
        type: "object",
        properties: { uniterable_property: { type: "string" } },
      },
    };
    let prompt = "";

    try {
      prompt = morphXmlSystemPromptTemplate([tool]);
    } finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        value: originalIterator,
      });
    }

    expect(prompt).toContain("  (no parameters)");
  });
});
