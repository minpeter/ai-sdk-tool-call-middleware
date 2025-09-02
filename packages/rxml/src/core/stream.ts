/**
 * Streaming XML parser based on TXML's transformStream approach
 * Provides memory-efficient parsing for large XML documents
 */

import { Readable, Transform, type TransformCallback } from "stream";

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
  private emittedCount = 0;
  private sawTagChar = false;

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
    encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    try {
      const incoming = chunk.toString();
      if (incoming.includes("<")) this.sawTagChar = true;
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
      // Find first '<'
      const openBracket = this.buffer.indexOf("<");
      if (openBracket === -1) {
        // No tags at all
        if (isFlush) this.buffer = "";
        break;
      }

      // Trim leading non-XML text
      if (openBracket > 0) {
        this.buffer = this.buffer.slice(openBracket);
      }

      // Skip processing instructions, comments, CDATA
      if (
        this.buffer.startsWith("<?") ||
        this.buffer.startsWith("<!--") ||
        this.buffer.startsWith("<![CDATA[")
      ) {
        const endMarkers: Record<string, string> = {
          "<?": "?>",
          "<!--": "-->",
          "<![CDATA[": "]]>",
        };
        let endMarker = "";
        for (const [start, end] of Object.entries(endMarkers)) {
          if (this.buffer.startsWith(start)) {
            endMarker = end;
            break;
          }
        }
        const endPos = endMarker ? this.buffer.indexOf(endMarker) : -1;
        if (endPos === -1) {
          if (!isFlush) break;
          // On flush, drop the incomplete special node
          this.buffer = "";
          break;
        }
        // Keep comment text as string node when requested
        if (this.parseOptions.keepComments && this.buffer.startsWith("<!--")) {
          this.push(this.buffer.slice(0, endPos + endMarker.length));
        }
        this.buffer = this.buffer.slice(endPos + endMarker.length);
        continue;
      }

      // Skip stray closing tags
      if (this.buffer.startsWith("</")) {
        const closeEnd = this.buffer.indexOf(">");
        if (closeEnd === -1) {
          if (!isFlush) break;
          this.buffer = "";
          break;
        }
        this.buffer = this.buffer.slice(closeEnd + 1);
        continue;
      }

      // Identify opening tag end and tag name (only proceed when we have the closing '>')
      const openTagEnd = this.buffer.indexOf(">");
      if (openTagEnd === -1) {
        if (!isFlush) break;
        // Incomplete open tag at flush; drop it
        this.buffer = "";
        break;
      }
      const openTagContent = this.buffer.slice(1, openTagEnd);
      const nameMatch = openTagContent.match(/^([a-zA-Z_][\w.-]*)/);
      if (!nameMatch) {
        // Not a valid tag start, drop one char and continue
        this.buffer = this.buffer.slice(1);
        continue;
      }
      const tagName = nameMatch[1];

      // Handle self-closing immediately
      const isSelfClosing = this.buffer[openTagEnd - 1] === "/";
      if (isSelfClosing) {
        const elementEnd = openTagEnd + 1;
        const elementXml = this.buffer.slice(0, elementEnd);
        try {
          const tokenizer = new XMLTokenizer(elementXml, this.parseOptions);
          const node = tokenizer.parseNode();
          this.emitElementAndChildren(node);
          this.buffer = this.buffer.slice(elementEnd);
          continue;
        } catch {
          // Skip this malformed self-closing element
          this.buffer = this.buffer.slice(1);
          continue;
        }
      }

      // Find matching closing tag with depth handling
      let depth = 1;
      let searchStart = openTagEnd + 1;
      let elementEnd = -1;
      while (searchStart < this.buffer.length) {
        // Ensure the next opening match is an actual tag name boundary
        let nextOpen = this.buffer.indexOf(`<${tagName}`, searchStart);
        while (nextOpen !== -1) {
          const after = this.buffer[nextOpen + tagName.length + 1];
          if (after === undefined || after === ">" || /\s/.test(after)) break;
          nextOpen = this.buffer.indexOf(`<${tagName}`, nextOpen + 1);
        }

        // Find the next closing tag start (position of '<')
        const nextCloseStart = this.buffer.indexOf(`</${tagName}`, searchStart);
        if (nextCloseStart === -1) break;

        if (nextOpen !== -1 && nextOpen < nextCloseStart) {
          depth++;
          searchStart = nextOpen + 1;
        } else {
          depth--;
          // Advance past the actual closing tag allowing optional whitespace before '>'
          let p = nextCloseStart + 2 + tagName.length; // after </tagName
          while (p < this.buffer.length && /\s/.test(this.buffer[p])) p++;
          if (this.buffer[p] !== ">") break; // malformed/incomplete closing tag
          const closeAdvance = p + 1;
          searchStart = closeAdvance;
          if (depth === 0) {
            elementEnd = searchStart;
            break;
          }
        }
      }

      if (elementEnd === -1) {
        if (!isFlush) break;
        // At flush with incomplete element; drop leading '<' to prevent infinite loop
        this.buffer = this.buffer.slice(1);
        continue;
      }

      // We have a complete element; parse and emit
      const elementXml = this.buffer.slice(0, elementEnd);
      try {
        const tokenizer = new XMLTokenizer(elementXml, this.parseOptions);
        const node = tokenizer.parseNode();
        this.emitElementAndChildren(node);
        this.buffer = this.buffer.slice(elementEnd);
      } catch (e) {
        // Malformed complete element; surface as stream error
        this.emit("error", new RXMLStreamError("Parse error", e as Error));
        return;
      }
    }
  }

  /**
   * Emit an element and recursively emit its children as separate events
   */
  private emitElementAndChildren(node: RXMLNode | string): void {
    if (typeof node === "string") {
      // Emit comment nodes if requested
      if (this.parseOptions.keepComments && node.includes("<!--")) {
        this.push(node);
        this.emittedCount++;
      }
      return;
    }

    // Emit the element itself
    this.push(node);
    this.emittedCount++;

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
): AsyncGenerator<RXMLNode | string, void, unknown> {
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
      if (error) {
        throw new RXMLStreamError("Stream processing error", error);
      }
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
