/**
 * Streaming XML parser based on TXML's transformStream approach
 * Provides memory-efficient parsing for large XML documents
 */

import { Readable, Transform } from "stream";

import { RXMLStreamError } from "../errors/types";
import { XMLTokenizer } from "./tokenizer";
import type { ParseOptions, RXMLNode } from "./types";

/**
 * Transform stream for parsing XML
 */
export class XMLTransformStream extends Transform {
  private buffer = "";
  private position: number;
  private readonly parseOptions: ParseOptions;

  constructor(offset?: number | string, parseOptions: ParseOptions = {}) {
    super({ readableObjectMode: true });

    if (typeof offset === "string") {
      this.position = offset.length;
    } else {
      this.position = offset || 0;
    }

    this.parseOptions = {
      keepComments: false,
      keepWhitespace: false,
      ...parseOptions,
    };
  }

  _transform(
    chunk: Buffer,
    encoding: string,
    callback: (error?: Error, data?: any) => void
  ): void {
    try {
      this.buffer += chunk.toString();
      this.processBuffer();
      callback();
    } catch (error) {
      callback(new RXMLStreamError("Transform error", error));
    }
  }

  _flush(callback: (error?: Error, data?: any) => void): void {
    try {
      // Process any remaining buffer content
      if (this.buffer.length > 0) {
        this.processBuffer(true);
      }
      callback();
    } catch (error) {
      callback(new RXMLStreamError("Flush error", error));
    }
  }

  private processBuffer(isFlush = false): void {
    let searchPos = 0;

    while (true) {
      // Find the next opening tag
      const openPos = this.buffer.indexOf("<", searchPos);
      if (openPos === -1) {
        // No more opening tags
        if (!isFlush) {
          // Keep unprocessed data for next chunk
          this.buffer = this.buffer.slice(searchPos);
          this.position = 0;
        }
        return;
      }

      // Skip closing tags
      if (this.buffer[openPos + 1] === "/") {
        searchPos = openPos + 1;
        continue;
      }

      // Handle comments
      if (
        this.buffer[openPos + 1] === "!" &&
        this.buffer[openPos + 2] === "-" &&
        this.buffer[openPos + 3] === "-"
      ) {
        const commentEnd = this.buffer.indexOf("-->", openPos + 4);
        if (commentEnd === -1) {
          if (!isFlush) {
            this.buffer = this.buffer.slice(searchPos);
            this.position = 0;
            return;
          }
          searchPos = this.buffer.length;
        } else {
          if (this.parseOptions.keepComments) {
            const commentContent = this.buffer.substring(
              openPos,
              commentEnd + 3
            );
            this.push(commentContent);
          }
          searchPos = commentEnd + 3;
        }
        continue;
      }

      // Try to parse a complete element starting at openPos
      try {
        const tokenizer = new XMLTokenizer(this.buffer, {
          ...this.parseOptions,
          pos: openPos,
        });

        const node = tokenizer.parseNode();

        // Get the new position from the tokenizer
        const newPos = tokenizer.getPosition();

        if (newPos > this.buffer.length || newPos <= openPos) {
          if (!isFlush) {
            // Incomplete element, wait for more data
            this.buffer = this.buffer.slice(searchPos);
            this.position = 0;
            return;
          }
          // If flushing and still incomplete, skip this element
          searchPos = openPos + 1;
        } else {
          // Successfully parsed element
          this.emitElementAndChildren(node);
          searchPos = newPos;
        }
      } catch (error) {
        if (!isFlush) {
          // Incomplete element, wait for more data
          this.buffer = this.buffer.slice(searchPos);
          this.position = 0;
          return;
        } else {
          // If flushing and parse fails, skip this position
          searchPos = openPos + 1;
        }
      }
    }
  }

  /**
   * Emit an element and recursively emit its children as separate events
   */
  private emitElementAndChildren(node: RXMLNode | string): void {
    if (typeof node === "string") {
      // Don't emit text nodes separately in streaming mode
      return;
    }

    // Emit the element itself
    this.push(node);

    // Recursively emit children
    for (const child of node.children) {
      this.emitElementAndChildren(child);
    }
  }
}

/**
 * Create a transform stream for parsing XML
 */
export function createXMLStream(
  offset?: number | string,
  parseOptions?: ParseOptions
): XMLTransformStream {
  return new XMLTransformStream(offset, parseOptions);
}

/**
 * Parse XML from a readable stream
 */
export async function parseFromStream(
  stream: Readable,
  offset?: number | string,
  parseOptions?: ParseOptions
): Promise<(RXMLNode | string)[]> {
  return new Promise((resolve, reject) => {
    const results: (RXMLNode | string)[] = [];
    const transformStream = createXMLStream(offset, parseOptions);

    transformStream.on("data", (element: RXMLNode | string) => {
      results.push(element);
    });

    transformStream.on("end", () => {
      resolve(results);
    });

    transformStream.on("error", (error: Error) => {
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
): AsyncGenerator<RXMLNode | string, void, unknown> {
  const transformStream = createXMLStream(offset, parseOptions);

  let ended = false;
  let error: Error | null = null;
  const queue: (RXMLNode | string)[] = [];
  let resolveNext: ((value: IteratorResult<RXMLNode | string>) => void) | null =
    null;

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
  });

  transformStream.on("error", (err: Error) => {
    error = err;
    if (resolveNext) {
      resolveNext({ value: undefined, done: true });
      resolveNext = null;
    }
  });

  stream.pipe(transformStream);

  while (true) {
    if (error) {
      throw new RXMLStreamError("Stream processing error", error);
    }

    if (queue.length > 0) {
      yield queue.shift()!;
      continue;
    }

    if (ended) {
      break;
    }

    // Wait for next element
    const result = await new Promise<IteratorResult<RXMLNode | string>>(
      resolve => {
        resolveNext = resolve;
      }
    );

    if (result.done) {
      break;
    }

    yield result.value;
  }
}

/**
 * Find elements by ID in streaming fashion
 */
export async function* findElementByIdStream(
  stream: Readable,
  id: string,
  offset?: number | string,
  parseOptions?: ParseOptions
): AsyncGenerator<RXMLNode, void, unknown> {
  for await (const element of processXMLStream(stream, offset, parseOptions)) {
    if (typeof element === "object" && element.attributes.id === id) {
      yield element;
    }
  }
}

/**
 * Find elements by class name in streaming fashion
 */
export async function* findElementsByClassStream(
  stream: Readable,
  className: string,
  offset?: number | string,
  parseOptions?: ParseOptions
): AsyncGenerator<RXMLNode, void, unknown> {
  const classRegex = new RegExp(`\\b${className}\\b`);

  for await (const element of processXMLStream(stream, offset, parseOptions)) {
    if (
      typeof element === "object" &&
      element.attributes.class &&
      classRegex.test(element.attributes.class)
    ) {
      yield element;
    }
  }
}
