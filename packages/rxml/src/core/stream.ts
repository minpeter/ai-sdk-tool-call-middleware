/**
 * Streaming XML parser based on TXML's transformStream approach
 * Provides memory-efficient parsing for large XML documents
 */

import { type Readable, Transform, type TransformCallback } from "node:stream";

import { RXMLStreamError } from "../errors/types";
import { XMLTokenizer } from "./tokenizer";
import type { ParseOptions, RXMLNode } from "./types";

// Regex patterns used at module level for performance
const TAG_NAME_REGEX = /^([a-zA-Z_][\w.-]*)/;
const WHITESPACE_REGEX = /\s/;

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
    const openBracket = this.buffer.indexOf("<");
    if (openBracket === -1) {
      if (isFlush) {
        this.buffer = "";
      }
      return false;
    }

    if (openBracket > 0) {
      this.buffer = this.buffer.slice(openBracket);
    }
    return true;
  }

  private tryProcessSpecialNode(isFlush: boolean): boolean {
    if (
      !this.buffer.startsWith("<?") &&
      !this.buffer.startsWith("<!--") &&
      !this.buffer.startsWith("<![CDATA[")
    ) {
      return false;
    }

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
      if (isFlush) {
        this.buffer = "";
      }
      return true;
    }

    if (this.parseOptions.keepComments && this.buffer.startsWith("<!--")) {
      this.push(this.buffer.slice(0, endPos + endMarker.length));
    }
    this.buffer = this.buffer.slice(endPos + endMarker.length);
    return true;
  }

  private trySkipStrayClosingTag(isFlush: boolean): boolean {
    if (!this.buffer.startsWith("</")) {
      return false;
    }

    const closeEnd = this.buffer.indexOf(">");
    if (closeEnd === -1) {
      if (isFlush) {
        this.buffer = "";
      }
      return true;
    }

    this.buffer = this.buffer.slice(closeEnd + 1);
    return true;
  }

  private extractTagInfo(isFlush: boolean): { openTagEnd: number; tagName: string } | null {
    const openTagEnd = this.buffer.indexOf(">");
    if (openTagEnd === -1) {
      if (isFlush) {
        this.buffer = "";
      }
      return null;
    }

    const openTagContent = this.buffer.slice(1, openTagEnd);
    const nameMatch = openTagContent.match(TAG_NAME_REGEX);
    if (!nameMatch) {
      this.buffer = this.buffer.slice(1);
      return null;
    }

    return { openTagEnd, tagName: nameMatch[1] };
  }

  private tryProcessSelfClosingTag(tagInfo: { openTagEnd: number; tagName: string }): boolean {
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

  private tryProcessRegularElement(tagInfo: { openTagEnd: number; tagName: string }, isFlush: boolean): boolean {
    const elementEnd = this.findMatchingClosingTag(tagInfo.tagName, tagInfo.openTagEnd);
    
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

  private findMatchingClosingTag(tagName: string, openTagEnd: number): number {
    let depth = 1;
    let searchStart = openTagEnd + 1;

    while (searchStart < this.buffer.length) {
      const nextOpen = this.findNextOpeningTag(tagName, searchStart);
      const nextCloseStart = this.buffer.indexOf(`</${tagName}`, searchStart);
      
      if (nextCloseStart === -1) {
        return -1;
      }

      if (nextOpen !== -1 && nextOpen < nextCloseStart) {
        depth++;
        searchStart = nextOpen + 1;
      } else {
        depth--;
        const closeAdvance = this.advancePastClosingTag(tagName, nextCloseStart);
        if (closeAdvance === -1) {
          return -1;
        }
        searchStart = closeAdvance;
        if (depth === 0) {
          return searchStart;
        }
      }
    }

    return -1;
  }

  private findNextOpeningTag(tagName: string, searchStart: number): number {
    let nextOpen = this.buffer.indexOf(`<${tagName}`, searchStart);
    while (nextOpen !== -1) {
      const after = this.buffer[nextOpen + tagName.length + 1];
      if (after === undefined || after === ">" || WHITESPACE_REGEX.test(after)) {
        break;
      }
      nextOpen = this.buffer.indexOf(`<${tagName}`, nextOpen + 1);
    }
    return nextOpen;
  }

  private advancePastClosingTag(tagName: string, nextCloseStart: number): number {
    let p = nextCloseStart + 2 + tagName.length;
    while (p < this.buffer.length && WHITESPACE_REGEX.test(this.buffer[p])) {
      p++;
    }
    if (this.buffer[p] !== ">") {
      return -1;
    }
    return p + 1;
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
