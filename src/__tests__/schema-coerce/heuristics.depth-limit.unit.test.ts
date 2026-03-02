import { describe, expect, it, vi } from "vitest";

import { coerceBySchema } from "../../schema-coerce";

describe("schema-coerce depth limit", () => {
  it("caps recursive coercion when maxDepth is reached", () => {
    const onMaxDepthExceeded = vi.fn();
    const value = {
      outer: {
        inner: {
          count: "12",
        },
      },
    };
    const schema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            inner: {
              type: "object",
              properties: {
                count: { type: "number" },
              },
            },
          },
        },
      },
    };

    const coerced = coerceBySchema(value, schema, {
      maxDepth: 2,
      onMaxDepthExceeded,
    }) as {
      outer: {
        inner: {
          count: unknown;
        };
      };
    };

    expect(coerced.outer.inner.count).toBe("12");
    expect(onMaxDepthExceeded).toHaveBeenCalledOnce();
    expect(onMaxDepthExceeded.mock.calls[0]?.[0]).toMatchObject({
      maxDepth: 2,
      schemaType: "object",
      valueType: "object",
    });
  });

  it("continues deep coercion when maxDepth allows it", () => {
    const value = {
      outer: {
        inner: {
          count: "12",
        },
      },
    };
    const schema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            inner: {
              type: "object",
              properties: {
                count: { type: "number" },
              },
            },
          },
        },
      },
    };

    const coerced = coerceBySchema(value, schema, {
      maxDepth: 8,
    }) as {
      outer: {
        inner: {
          count: unknown;
        };
      };
    };

    expect(coerced.outer.inner.count).toBe(12);
  });
});
