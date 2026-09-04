import { describe, expect, it } from "vitest";

import {
  expectGeneratedMorphInput,
  morphArrayTool,
} from "../heuristic-test-harness";

describe("XML Protocol Heuristic Parsing", () => {
  describe("Internal array structure processing", () => {
    it("should extract array from single key object", () => {
      const text = `<get_numbers>
        <values>
          <number>3</number>
          <number>5</number>
          <number>7</number>
        </values>
      </get_numbers>`;
      const tools = [morphArrayTool("get_numbers", "values", "number")];

      const input = expectGeneratedMorphInput(text, tools);
      expect(input.values).toEqual([3, 5, 7]);
    });

    it("should extract string array from single key object", () => {
      const text = `<get_colors>
        <palette>
          <color>red</color>
          <color>green</color>
          <color>blue</color>
        </palette>
      </get_colors>`;
      const tools = [morphArrayTool("get_colors", "palette", "string")];

      const input = expectGeneratedMorphInput(text, tools);
      expect(input.palette).toEqual(["red", "green", "blue"]);
    });
  });
});
