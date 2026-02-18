import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { morphXmlProtocol } from "../../../../core/protocols/morph-xml-protocol";

describe("morphXmlProtocol pipeline integration", () => {
  const simpleTools: LanguageModelV3FunctionTool[] = [
    {
      type: "function",
      name: "get_weather",
      inputSchema: {
        type: "object",
        properties: {
          location: { type: "string" },
        },
      },
    },
  ];

  describe("default behavior (no options)", () => {
    it("should parse valid XML without pipeline", () => {
      const protocol = morphXmlProtocol();
      const text = "<get_weather><location>Seoul</location></get_weather>";

      const result = protocol.parseGeneratedText({ text, tools: simpleTools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");
      if (result[0].type === "tool-call") {
        expect(JSON.parse(result[0].input)).toEqual({ location: "Seoul" });
      }
    });

    it("should recover malformed close tags without pipeline", () => {
      const protocol = morphXmlProtocol();
      const text = "<get_weather><location>Seoul</get_weather>";

      const result = protocol.parseGeneratedText({ text, tools: simpleTools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");
    });
  });

  describe("repair toggle", () => {
    it("should not repair malformed XML when repair=false", () => {
      const protocol = morphXmlProtocol({
        parseOptions: { repair: false },
      });
      const text = "<get_weather><location>Seoul</get_weather>";

      const result = protocol.parseGeneratedText({ text, tools: simpleTools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("text");
    });

    it("should still parse valid XML when repair=false", () => {
      const protocol = morphXmlProtocol({
        parseOptions: { repair: false },
      });
      const text = "<get_weather><location>Seoul</location></get_weather>";

      const result = protocol.parseGeneratedText({ text, tools: simpleTools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");
      if (result[0].type === "tool-call") {
        expect(JSON.parse(result[0].input)).toEqual({ location: "Seoul" });
      }
    });
  });

  describe("balance -> dedupe chain (regression test)", () => {
    const shellTools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "shell",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "array",
              items: { type: "string" },
            },
            description: { type: "string" },
          },
        },
      },
    ];

    it("should recover when balance fixes tags but creates duplicate string tags", () => {
      const protocol = morphXmlProtocol();

      const text = `<shell>
        <command>echo "hello"</command>
        <description>First description</description>
        <description>Second description (should be removed)</description>
      </shell>`;

      const result = protocol.parseGeneratedText({ text, tools: shellTools });

      expect(result).toHaveLength(1);
      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.description).toBe(
          "Second description (should be removed)"
        );
      }
    });

    it("should handle malformed close tags with duplicate string tags", () => {
      const protocol = morphXmlProtocol();

      const text = `<shell>
        <command>ls -la</command>
        <description>List files</ description>
        <description>Show all</description>
      </shell>`;

      const result = protocol.parseGeneratedText({ text, tools: shellTools });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");
      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.description).toBe("Show all");
      }
    });
  });

  describe("maxReparses behavior", () => {
    const shellTools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "shell",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "array",
              items: { type: "string" },
            },
            description: { type: "string" },
          },
        },
      },
    ];

    const duplicateDescription = `<shell>
      <command>echo "hello"</command>
      <description>First</description>
      <description>Second</description>
    </shell>`;

    it("should fail to repair when maxReparses is 0", () => {
      const protocol = morphXmlProtocol({
        parseOptions: { maxReparses: 0 },
      });

      const result = protocol.parseGeneratedText({
        text: duplicateDescription,
        tools: shellTools,
      });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("text");
    });

    it("should repair duplicates when maxReparses allows reparsing", () => {
      const protocol = morphXmlProtocol({
        parseOptions: { maxReparses: 2 },
      });

      const result = protocol.parseGeneratedText({
        text: duplicateDescription,
        tools: shellTools,
      });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe("tool-call");
      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.description).toBe("Second");
      }
    });
  });

  describe("repair vs strict parsing", () => {
    it("should produce same result for valid XML with or without repair", () => {
      const strict = morphXmlProtocol({ parseOptions: { repair: false } });
      const repaired = morphXmlProtocol();

      const text = "<get_weather><location>Seoul</location></get_weather>";

      const resultStrict = strict.parseGeneratedText({
        text,
        tools: simpleTools,
      });
      const resultRepaired = repaired.parseGeneratedText({
        text,
        tools: simpleTools,
      });

      expect(resultStrict).toHaveLength(1);
      expect(resultRepaired).toHaveLength(1);

      if (
        resultStrict[0].type === "tool-call" &&
        resultRepaired[0].type === "tool-call"
      ) {
        expect(JSON.parse(resultStrict[0].input)).toEqual(
          JSON.parse(resultRepaired[0].input)
        );
      }
    });

    it("should recover malformed close tags only when repair is enabled", () => {
      const strict = morphXmlProtocol({ parseOptions: { repair: false } });
      const repaired = morphXmlProtocol();

      const text = "<get_weather><location>Seoul</get_weather>";

      const resultStrict = strict.parseGeneratedText({
        text,
        tools: simpleTools,
      });
      const resultRepaired = repaired.parseGeneratedText({
        text,
        tools: simpleTools,
      });

      expect(resultStrict[0].type).toBe("text");
      expect(resultRepaired[0].type).toBe("tool-call");
    });
  });

  describe("index tags preservation", () => {
    const coordTools: LanguageModelV3FunctionTool[] = [
      {
        type: "function",
        name: "set_coordinates",
        inputSchema: {
          type: "object",
          properties: {
            coordinates: {
              type: "array",
              items: { type: "number" },
            },
          },
        },
      },
    ];

    it("should preserve <0>, <1> index tags", () => {
      const protocol = morphXmlProtocol();
      const text = `<set_coordinates>
        <coordinates>
          <0>10.5</0>
          <1>20.3</1>
        </coordinates>
      </set_coordinates>`;

      const result = protocol.parseGeneratedText({ text, tools: coordTools });

      expect(result).toHaveLength(1);
      if (result[0].type === "tool-call") {
        const input = JSON.parse(result[0].input);
        expect(input.coordinates).toEqual([10.5, 20.3]);
      }
    });
  });
});
