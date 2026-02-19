import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { parseFromStream } from "../../../rxml/core/stream";
import { RXMLStreamError } from "../../../rxml/errors/types";
import {
  CHUNK_SIZE,
  createChunkedStream,
  testXmlSamples,
} from "./stream-chunked.shared";

describe("rxml parseFromStream", () => {
  it("parses chunked XML and releases source error listeners on success", async () => {
    const stream = createChunkedStream(testXmlSamples.simple, CHUNK_SIZE);

    const results = await parseFromStream(stream);

    expect(
      results.some(
        (node) => typeof node === "object" && node.tagName === "tool_call"
      )
    ).toBe(true);
    expect(
      results.some(
        (node) => typeof node === "object" && node.tagName === "name"
      )
    ).toBe(true);
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("wraps source stream errors as RXMLStreamError and detaches listeners", async () => {
    const stream = new Readable({
      read() {
        this.push("<tool_call>");
        this.destroy(new Error("source stream failed"));
      },
    });

    await expect(parseFromStream(stream)).rejects.toThrow(RXMLStreamError);
    await new Promise((resolve) => setImmediate(resolve));
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("rejects truncated xml streams that never produce a complete element", async () => {
    const stream = createChunkedStream("<tool_call", 3);

    await expect(parseFromStream(stream)).rejects.toThrow(RXMLStreamError);
  });
});
