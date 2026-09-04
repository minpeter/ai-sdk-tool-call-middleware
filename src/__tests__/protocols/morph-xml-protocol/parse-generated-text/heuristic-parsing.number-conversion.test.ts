import { describe, expect, it } from "vitest";

import {
  expectGeneratedMorphInput,
  morphArrayTool,
} from "../heuristic-test-harness";

describe("XML Protocol Heuristic Parsing", () => {
  describe("Number conversion accuracy", () => {
    it("should handle floating point precision correctly", () => {
      const text = `<test_precision>
        <values>
          <item>1.2345678900000000</item>
          <item>2.0000000000000001</item>
          <item>3.1415926535897932</item>
        </values>
      </test_precision>`;
      const tools = [morphArrayTool("test_precision", "values", "number")];

      const input = expectGeneratedMorphInput<{ values: number[] }>(
        text,
        tools
      );

      expect(input.values[0]).toBeCloseTo(1.234_567_89);
      expect(input.values[1]).toBeCloseTo(2.0);
      expect(input.values[2]).toBeCloseTo(Math.PI);
    });

    it("should handle scientific notation", () => {
      const text = `<scientific_values>
        <data>
          <item>1.23e-4</item>
          <item>5.67E+2</item>
          <item>-9.87e-10</item>
        </data>
      </scientific_values>`;
      const tools = [morphArrayTool("scientific_values", "data", "number")];

      const input = expectGeneratedMorphInput<{ data: number[] }>(text, tools);

      expect(input.data[0]).toBeCloseTo(0.000_123);
      expect(input.data[1]).toBeCloseTo(567);
      expect(input.data[2]).toBeCloseTo(-0.000_000_000_987);
    });
  });
});
