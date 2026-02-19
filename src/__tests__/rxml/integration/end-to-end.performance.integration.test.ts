import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parse } from "../../../rxml/parse";

describe("robust-xml integration", () => {
  describe("performance characteristics", () => {
    it("handles reasonable performance for medium-sized documents", () => {
      const mediumXml = `<data>${Array.from(
        { length: 100 },
        (_, i) =>
          `<record id="${i}"><name>Record ${i}</name><value>${Math.random()}</value><active>${i % 2 === 0}</active></record>`
      ).join("")}</data>`;

      const schema = z.toJSONSchema(
        z.object({
          data: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              value: z.number(),
              active: z.boolean(),
            })
          ),
        })
      );

      const startTime = Date.now();
      const result = parse(mediumXml, schema);
      const durationMs = Date.now() - startTime;

      if (process.env.VITEST_PERF_CHECK === "1") {
        expect(durationMs).toBeLessThan(1000);
      }
      const data = (
        result as unknown as { data: Array<{ value: number; active: boolean }> }
      ).data;
      expect(data).toHaveLength(100);
      expect(typeof data[0].value).toBe("number");
      expect(typeof data[0].active).toBe("boolean");
    });
  });
});
