import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { RxmlValue } from "../../../rxml/builders/stringify";
import { parse } from "../../../rxml/parse";

type RxmlRecord = Readonly<Record<string, RxmlValue>>;

function isRxmlRecord(value: RxmlValue): value is RxmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
      const data: RxmlValue = result.data;
      if (!Array.isArray(data)) {
        expect.fail("parsed data was not an array");
      }
      expect(data).toHaveLength(100);
      const [firstRecord] = data;
      if (!isRxmlRecord(firstRecord)) {
        expect.fail("first parsed record was not an object");
      }
      expect(typeof firstRecord.value).toBe("number");
      expect(typeof firstRecord.active).toBe("boolean");
    });
  });
});
