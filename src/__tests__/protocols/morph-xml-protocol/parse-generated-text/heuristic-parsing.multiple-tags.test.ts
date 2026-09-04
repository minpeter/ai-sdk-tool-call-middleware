import { describe, expect, it } from "vitest";

import {
  expectGeneratedMorphInput,
  morphObjectTool,
} from "../heuristic-test-harness";

describe("XML Protocol Heuristic Parsing", () => {
  describe("Multiple tags handling", () => {
    it("should convert multiple same-named tags to array", () => {
      const text = `<math_toolkit_sum_of_multiples>
        <lower_limit>1</lower_limit>
        <upper_limit>1000</upper_limit>
        <multiples>3</multiples>
        <multiples>5</multiples>
      </math_toolkit_sum_of_multiples>`;
      const tools = [
        morphObjectTool("math_toolkit_sum_of_multiples", {
          lower_limit: { type: "number" },
          upper_limit: { type: "number" },
          multiples: { type: "array", items: { type: "number" } },
        }),
      ];

      const input = expectGeneratedMorphInput(text, tools);

      expect(input.lower_limit).toBe(1);
      expect(input.upper_limit).toBe(1000);
      expect(input.multiples).toEqual([3, 5]);
    });

    it("should handle multiple tags with text content", () => {
      const text = `<get_cities>
        <country>France</country>
        <city>Paris</city>
        <city>Lyon</city>
        <city>Marseille</city>
      </get_cities>`;
      const tools = [
        morphObjectTool("get_cities", {
          country: { type: "string" },
          city: { type: "array", items: { type: "string" } },
        }),
      ];

      const input = expectGeneratedMorphInput(text, tools);

      expect(input.country).toBe("France");
      expect(input.city).toEqual(["Paris", "Lyon", "Marseille"]);
    });
  });
});
