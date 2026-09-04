import type { JSONSchema7Definition } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import {
  expectGeneratedMorphInput,
  morphObjectTool,
} from "../heuristic-test-harness";

describe("XML Protocol Heuristic Parsing", () => {
  describe("Item key pattern processing", () => {
    it("should convert item array to direct array", () => {
      const text = `<weather_get_by_coordinates_date>
        <coordinates>
          <item>46.603354</item>
          <item>1.8883340</item>
        </coordinates>
        <date>2023-12-25</date>
      </weather_get_by_coordinates_date>`;
      const tools = [
        morphObjectTool("weather_get_by_coordinates_date", {
          coordinates: { type: "array", items: { type: "number" } },
          date: { type: "string" },
        }),
      ];

      const input = expectGeneratedMorphInput(text, tools);

      expect(input.coordinates).toEqual([46.603_354, 1.888_334]);
      expect(input.date).toBe("2023-12-25");
    });

    it("should handle single item value", () => {
      const text = `<get_single_value>
        <data>
          <item>42</item>
        </data>
      </get_single_value>`;
      const tools = [
        morphObjectTool("get_single_value", { data: { type: "number" } }),
      ];

      const input = expectGeneratedMorphInput(text, tools);

      expect(input.data).toBe(42);
    });

    it("should convert string numbers to actual numbers in item arrays", () => {
      const text = `<calculate_distance>
        <point1>
          <item>10.5</item>
          <item>20.3</item>
        </point1>
        <point2>
          <item>15.8</item>
          <item>25.1</item>
        </point2>
      </calculate_distance>`;
      const numericItems: JSONSchema7Definition = {
        type: "array",
        items: { type: "number" },
      };
      const tools = [
        morphObjectTool("calculate_distance", {
          point1: numericItems,
          point2: numericItems,
        }),
      ];

      const input = expectGeneratedMorphInput<{
        point1: number[];
        point2: number[];
      }>(text, tools);

      expect(input.point1).toEqual([10.5, 20.3]);
      expect(input.point2).toEqual([15.8, 25.1]);
      expect(typeof input.point1[0]).toBe("number");
      expect(typeof input.point2[1]).toBe("number");
    });
  });
});
