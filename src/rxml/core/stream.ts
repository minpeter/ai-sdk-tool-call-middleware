/**
 * Streaming XML parser based on TXML's transformStream approach
 * Provides memory-efficient parsing for large XML documents
 */

import { type Readable, Transform, type TransformCallback } from "node:stream";

import { RXMLStreamError } from "../errors/types";
import {
  findMatchingClosingTag,
  readSpecialNode,
  readTagInfo,
  skipStrayClosingTag,
  trimToNextTag,
} from "./stream-boundaries";
import { visitStreamElements } from "./stream-elements";
import { XMLTokenizer } from "./tokenizer";
import type { ParseOptions, RXMLNode } from "./types";

/**
 * Transform stream for parsing XML
 */
class XMLTransformStream extends Transform {
  private buffer = "";
  private readonly parseOptions: ParseOptions;
  private emittedCount = 0;
  private sawTagChar = false;

  constructor(_offset?: number | string, parseOptions: ParseOptions = {}) {
    super({ readableObjectMode: true });

    this.parseOptions = {
      keepComments: false,
      keepWhitespace: false,
      ...parseOptions,
    };
  }

  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    try {
      const incoming = chunk.toString();
      if (incoming.includes("<")) {
        this.sawTagChar = true;
      }
      this.buffer += incoming;
      this.processBuffer();
      callback();
    } catch (error) {
      callback(new RXMLStreamError("Transform error", error));
    }
  }

  _flush(callback: TransformCallback): void {
    try {
      // Process any remaining buffer content
      if (this.buffer.length > 0) {
        this.processBuffer(true);
      }
      // If we saw XML-like input but emitted nothing, surface a meaningful error
      if (this.sawTagChar && this.emittedCount === 0) {
        throw new RXMLStreamError(
          "Flush error",
          new Error("No XML elements could be parsed from stream")
        );
      }
      callback();
    } catch (error) {
      callback(new RXMLStreamError("Flush error", error));
    }
  }

  private processBuffer(isFlush = false): void {
    // Try to find and emit complete XML elements in the buffer
    while (this.buffer.length > 0) {
      if (!this.trimToNextTag(isFlush)) {
        break;
      }

      if (this.tryProcessSpecialNode(isFlush)) {
        continue;
      }

      if (this.trySkipStrayClosingTag(isFlush)) {
        continue;
      }

      const tagInfo = this.extractTagInfo(isFlush);
      if (!tagInfo) {
        break;
      }

      if (this.tryProcessSelfClosingTag(tagInfo)) {
        continue;
      }

      if (!this.tryProcessRegularElement(tagInfo, isFlush)) {
        break;
      }
    }
  }

  private trimToNextTag(isFlush: boolean): boolean {
    const result = trimToNextTag(this.buffer, isFlush);
    this.buffer = result.remainder;
    return result.found;
  }

  private tryProcessSpecialNode(isFlush: boolean): boolean {
    const result = readSpecialNode(
      this.buffer,
      isFlush,
      this.parseOptions.keepComments ?? false
    );
    if (result === null) {
      return false;
    }
    this.buffer = result.remainder;
    if (result.emittedComment !== null) {
      this.push(result.emittedComment);
    }
    return result.handled;
  }

  private trySkipStrayClosingTag(isFlush: boolean): boolean {
    const remainder = skipStrayClosingTag(this.buffer, isFlush);
    if (remainder === null) {
      return false;
    }
    this.buffer = remainder;
    return true;
  }

  private extractTagInfo(
    isFlush: boolean
  ): { openTagEnd: number; tagName: string } | null {
    const result = readTagInfo(this.buffer, isFlush);
    this.buffer = result.remainder;
    return result.tagInfo;
  }

  private tryProcessSelfClosingTag(tagInfo: {
    openTagEnd: number;
    tagName: string;
  }): boolean {
    const isSelfClosing = this.buffer[tagInfo.openTagEnd - 1] === "/";
    if (!isSelfClosing) {
      return false;
    }

    const elementEnd = tagInfo.openTagEnd + 1;
    const elementXml = this.buffer.slice(0, elementEnd);
    try {
      const tokenizer = new XMLTokenizer(elementXml, this.parseOptions);
      const node = tokenizer.parseNode();
      this.emitElementAndChildren(node);
      this.buffer = this.buffer.slice(elementEnd);
      return true;
    } catch {
      this.buffer = this.buffer.slice(1);
      return true;
    }
  }

  private tryProcessRegularElement(
    tagInfo: { openTagEnd: number; tagName: string },
    isFlush: boolean
  ): boolean {
    const elementEnd = findMatchingClosingTag(
      this.buffer,
      tagInfo.tagName,
      tagInfo.openTagEnd
    );

    if (elementEnd === -1) {
      if (isFlush) {
        this.buffer = this.buffer.slice(1);
        return true;
      }
      return false;
    }

    const elementXml = this.buffer.slice(0, elementEnd);
    try {
      const tokenizer = new XMLTokenizer(elementXml, this.parseOptions);
      const node = tokenizer.parseNode();
      this.emitElementAndChildren(node);
      this.buffer = this.buffer.slice(elementEnd);
      return true;
    } catch (e) {
      this.emit("error", new RXMLStreamError("Parse error", e as Error));
      return false;
    }
  }

  /**
   * Emit an element and recursively emit its children as separate events
   */
  private emitElementAndChildren(node: RXMLNode | string): void {
    visitStreamElements(
      node,
      this.parseOptions.keepComments ?? false,
      (element) => {
        this.push(element);
        this.emittedCount += 1;
      }
    );
  }
}

/**
 * Create a transform stream for parsing XML
 */
function createXMLStream(
  offset?: number | string,
  parseOptions?: ParseOptions
): XMLTransformStream {
  return new XMLTransformStream(offset, parseOptions);
}

/**
 * Parse XML from a readable stream
 */
export function parseFromStream(
  stream: Readable,
  offset?: number | string,
  parseOptions?: ParseOptions
): Promise<(RXMLNode | string)[]> {
  return new Promise((resolve, reject) => {
    const results: (RXMLNode | string)[] = [];
    const transformStream = createXMLStream(offset, parseOptions);

    // Propagate source stream errors
    const onSourceError = (err: Error) => {
      transformStream.destroy(err);
    };
    stream.on("error", onSourceError);

    transformStream.on("data", (element: RXMLNode | string) => {
      results.push(element);
    });

    transformStream.on("end", () => {
      stream.off("error", onSourceError);
      resolve(results);
    });

    transformStream.on("error", (error: Error) => {
      stream.off("error", onSourceError);
      reject(new RXMLStreamError("Stream parsing failed", error));
    });

    stream.pipe(transformStream);
  });
}

/**
 * Process XML stream with async iterator support
 */
export async function* processXMLStream(
  stream: Readable,
  offset?: number | string,
  parseOptions?: ParseOptions
): AsyncGenerator<RXMLNode | string, void, void> {
  const transformStream = createXMLStream(offset, parseOptions);

  let ended = false;
  let error: Error | null = null;
  const queue: (RXMLNode | string)[] = [];
  let resolveNext: ((value: IteratorResult<RXMLNode | string>) => void) | null =
    null;

  // Ensure source stream errors are propagated and terminate iteration
  const onSourceError = (err: Error) => {
    error = err;
    transformStream.destroy(err);
  };
  stream.on("error", onSourceError);

  transformStream.on("data", (element: RXMLNode | string) => {
    if (resolveNext) {
      resolveNext({ value: element, done: false });
      resolveNext = null;
    } else {
      queue.push(element);
    }
  });

  transformStream.on("end", () => {
    ended = true;
    if (resolveNext) {
      resolveNext({ value: undefined, done: true });
      resolveNext = null;
    }
    stream.off("error", onSourceError);
  });

  transformStream.on("error", (err: Error) => {
    error = err;
    if (resolveNext) {
      resolveNext({ value: undefined, done: true });
      resolveNext = null;
    }
    stream.off("error", onSourceError);
  });

  stream.pipe(transformStream);

  while (true) {
    if (error) {
      throw new RXMLStreamError("Stream processing error", error);
    }

    if (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) {
        yield item;
      }
      continue;
    }

    if (ended) {
      break;
    }

    // Wait for next element
    const result = await new Promise<IteratorResult<RXMLNode | string>>(
      (resolve) => {
        resolveNext = resolve;
      }
    );

    if (result.done) {
      if (error) {
        throw new RXMLStreamError("Stream processing error", error);
      }
      break;
    }

    yield result.value;
  }
}
