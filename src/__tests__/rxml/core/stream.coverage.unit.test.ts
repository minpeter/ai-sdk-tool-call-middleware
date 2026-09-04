import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseFromStream, processXMLStream } from "../../../rxml/core/stream";
import { trimToNextTag } from "../../../rxml/core/stream-boundaries";
import { XMLTokenizer } from "../../../rxml/core/tokenizer";

vi.mock("../../../rxml/core/stream-boundaries", { spy: true });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rxml stream deterministic branch coverage", () => {
  it("ignores text that contains no XML tag opener", async () => {
    // Given
    const stream = Readable.from(["plain text"]);

    // When
    const result = await parseFromStream(stream);

    // Then
    expect(result).toEqual([]);
  });

  it.each(["<leaf", "<leaf>"])(
    "rejects XML-like input when flushing cannot emit an element: %s",
    async (xml) => {
      // Given
      const stream = Readable.from([xml]);

      // When
      const result = parseFromStream(stream);

      // Then
      await expect(result).rejects.toMatchObject({
        cause: {
          cause: {
            message: "Flush error",
            name: "RXMLStreamError",
          },
          message: "Flush error",
          name: "RXMLStreamError",
        },
        message: "Stream parsing failed",
        name: "RXMLStreamError",
      });
    }
  );

  it("discards comments when retention is disabled", async () => {
    // Given
    const stream = Readable.from(["<!--note--><leaf/>"]);

    // When
    const result = await parseFromStream(stream);

    // Then
    expect(result).toEqual([{ attributes: {}, children: [], tagName: "leaf" }]);
  });

  it("emits a retained comment before the following element", async () => {
    // Given
    const stream = Readable.from(["<!--note--><leaf/>"]);

    // When
    const result = await parseFromStream(stream, undefined, {
      keepComments: true,
    });

    // Then
    expect(result).toEqual([
      "<!--note-->",
      { attributes: {}, children: [], tagName: "leaf" },
    ]);
  });

  it("emits a self-closing element after discarding a stray closing tag", async () => {
    // Given
    const stream = Readable.from(["</orphan><leaf/>"]);

    // When
    const result = await parseFromStream(stream, undefined, {
      keepComments: undefined,
    });

    // Then
    expect(result).toEqual([{ attributes: {}, children: [], tagName: "leaf" }]);
  });

  it("recovers after tokenizer failure on a self-closing candidate", async () => {
    // Given
    vi.spyOn(XMLTokenizer.prototype, "parseNode").mockImplementationOnce(() => {
      throw new Error("rejected self-closing candidate");
    });
    const stream = Readable.from(["<bad/><good/>"]);

    // When
    const result = await parseFromStream(stream);

    // Then
    expect(result).toEqual([{ attributes: {}, children: [], tagName: "good" }]);
  });

  it("normalizes an Error thrown while transforming", async () => {
    // Given
    const cause = new Error("boundary failed");
    vi.mocked(trimToNextTag).mockImplementationOnce(() => {
      throw cause;
    });

    // When
    const result = parseFromStream(Readable.from(["<leaf/>"]));

    // Then
    await expect(result).rejects.toMatchObject({
      cause: {
        cause,
        message: "Transform error",
        name: "RXMLStreamError",
      },
      message: "Stream parsing failed",
      name: "RXMLStreamError",
    });
  });

  it("normalizes a non-Error value thrown while transforming", async () => {
    // Given
    vi.mocked(trimToNextTag).mockImplementationOnce(() => {
      throw Symbol("transform sentinel");
    });

    // When
    const result = parseFromStream(Readable.from(["<leaf/>"]));

    // Then
    await expect(result).rejects.toMatchObject({
      cause: {
        cause: {
          message: "Symbol(transform sentinel)",
          name: "Error",
        },
        message: "Transform error",
        name: "RXMLStreamError",
      },
      message: "Stream parsing failed",
      name: "RXMLStreamError",
    });
  });

  it("normalizes a non-Error value thrown while flushing", async () => {
    // Given
    const { trimToNextTag: originalTrimToNextTag } = await vi.importActual<
      typeof import("../../../rxml/core/stream-boundaries")
    >("../../../rxml/core/stream-boundaries");
    vi.mocked(trimToNextTag)
      .mockImplementationOnce(originalTrimToNextTag)
      .mockImplementationOnce(() => {
        throw Symbol("flush sentinel");
      });

    // When
    const result = parseFromStream(Readable.from(["<leaf"]));

    // Then
    await expect(result).rejects.toMatchObject({
      cause: {
        cause: {
          message: "Symbol(flush sentinel)",
          name: "Error",
        },
        message: "Flush error",
        name: "RXMLStreamError",
      },
      message: "Stream parsing failed",
      name: "RXMLStreamError",
    });
  });

  it("normalizes an Error tokenizer failure for a regular element", async () => {
    // Given
    const cause = new Error("regular tokenizer failed");
    vi.spyOn(XMLTokenizer.prototype, "parseNode").mockImplementationOnce(() => {
      throw cause;
    });
    const stream = Readable.from(["<leaf></leaf>"]);

    // When
    const result = parseFromStream(stream);

    // Then
    await expect(result).rejects.toMatchObject({
      cause: {
        cause,
        message: "Parse error",
        name: "RXMLStreamError",
      },
      message: "Stream parsing failed",
      name: "RXMLStreamError",
    });
  });

  it("normalizes a non-Error tokenizer failure for a regular element", async () => {
    // Given
    vi.spyOn(XMLTokenizer.prototype, "parseNode").mockImplementationOnce(() => {
      throw Symbol("tokenizer sentinel");
    });
    const stream = Readable.from(["<leaf></leaf>"]);

    // When
    const result = parseFromStream(stream);

    // Then
    await expect(result).rejects.toMatchObject({
      cause: {
        cause: {
          message: "Symbol(tokenizer sentinel)",
          name: "Error",
        },
        message: "Parse error",
        name: "RXMLStreamError",
      },
      message: "Stream parsing failed",
      name: "RXMLStreamError",
    });
  });

  it("wraps a source error while parsing and detaches its listener", async () => {
    // Given
    const cause = new Error("parse source failed");
    const stream = new PassThrough();
    const result = parseFromStream(stream);

    // When
    stream.destroy(cause);

    // Then
    await expect(result).rejects.toMatchObject({
      cause,
      message: "Stream parsing failed",
      name: "RXMLStreamError",
    });
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("drains queued child elements before completing iteration", async () => {
    // Given
    const stream = Readable.from(["<root><child/></root>"]);
    const iterator = processXMLStream(stream);

    // When
    const first = await iterator.next();
    const second = await iterator.next();
    const third = await iterator.next();

    // Then
    expect([first, second, third]).toEqual([
      {
        done: false,
        value: {
          attributes: {},
          children: [{ attributes: {}, children: [], tagName: "child" }],
          tagName: "root",
        },
      },
      {
        done: false,
        value: { attributes: {}, children: [], tagName: "child" },
      },
      { done: true, value: undefined },
    ]);
  });

  it("finishes a pending iterator read when an empty source ends", async () => {
    // Given
    const stream = new PassThrough();
    const iterator = processXMLStream(stream);
    const pendingResult = iterator.next();

    // When
    stream.end();

    // Then
    await expect(pendingResult).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it("rejects a pending iterator read when the source errors", async () => {
    // Given
    const cause = new Error("source failed while waiting");
    const stream = new PassThrough();
    const iterator = processXMLStream(stream);
    const pendingResult = iterator.next();

    // When
    stream.destroy(cause);

    // Then
    await expect(pendingResult).rejects.toMatchObject({
      cause,
      message: "Stream processing error",
      name: "RXMLStreamError",
    });
  });

  it("rejects the next iterator read when the source errors after a yield", async () => {
    // Given
    const cause = new Error("source failed after data");
    const stream = new PassThrough();
    const iterator = processXMLStream(stream, undefined, {
      keepComments: undefined,
    });
    const firstResult = iterator.next();
    stream.write("<leaf/>");
    await expect(firstResult).resolves.toEqual({
      done: false,
      value: { attributes: {}, children: [], tagName: "leaf" },
    });
    const sourceError = once(stream, "error");

    // When
    stream.destroy(cause);
    await sourceError;

    // Then
    await expect(iterator.next()).rejects.toMatchObject({
      cause,
      message: "Stream processing error",
      name: "RXMLStreamError",
    });
  });
});
