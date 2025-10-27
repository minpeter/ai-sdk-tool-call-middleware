/**
 * XML Tokenizer based on TXML's character-by-character parsing approach
 * with enhanced error tolerance and schema awareness
 */

import { RXMLParseError } from "../errors/types";
import { getLineColumn, parseName, parseString } from "../utils/helpers";
import type { ParseOptions, RXMLNode } from "./types";
import { CharCodes, DEFAULT_NO_CHILD_NODES } from "./types";

export class XMLTokenizer {
  private pos = 0;
  private readonly xmlString: string;
  private readonly options: ParseOptions;

  constructor(xmlString: string, options: ParseOptions = {}) {
    this.xmlString = xmlString;
    this.options = {
      keepComments: false,
      keepWhitespace: false,
      noChildNodes: DEFAULT_NO_CHILD_NODES.slice(),
      textNodeName: "#text",
      throwOnDuplicateStringTags: true,
      ...options,
    };
    this.pos = options.pos || 0;
  }

  /**
   * Handle closing tag parsing
   */
  private handleClosingTag(
    tagName: string | undefined,
    children: (RXMLNode | string)[]
  ): (RXMLNode | string)[] | null {
    const closeStart = this.pos + 2;
    this.pos = this.xmlString.indexOf(">", this.pos);

    const closeTag = this.xmlString.substring(closeStart, this.pos);
    if (tagName && closeTag.trim() !== tagName) {
      const { line, column } = getLineColumn(this.xmlString, this.pos);
      throw new RXMLParseError(
        `Unexpected close tag at line ${line}, column ${column}. Expected </${tagName}>, found </${closeTag}>`,
        undefined,
        line,
        column
      );
    }

    if (this.pos !== -1) {
      this.pos += 1;
    }
    return children;
  }

  /**
   * Check if we're at end of string and should throw unclosed tag error
   */
  private checkUnclosedTag(
    tagName: string | undefined,
    consumedToEnd: boolean
  ): void {
    if (tagName && this.pos >= this.xmlString.length && !consumedToEnd) {
      const { line, column } = getLineColumn(this.xmlString, this.pos - 1);
      throw new RXMLParseError(
        `Unclosed tag at line ${line}, column ${column}. Expected closing tag </${tagName}>`,
        undefined,
        line,
        column
      );
    }
  }

  /**
   * Process special content (comments, CDATA, DOCTYPE) and track if we consumed to end
   */
  private processSpecialContent(
    children: (RXMLNode | string)[]
  ): boolean {
    const prevPos = this.pos;
    this.handleSpecialContent(children);
    return (
      this.pos >= this.xmlString.length &&
      prevPos < this.xmlString.length
    );
  }

  /**
   * Handle text content parsing
   */
  private handleTextContent(children: (RXMLNode | string)[]): void {
    const text = this.parseText();
    if (this.options.keepWhitespace) {
      if (text.length > 0) {
        children.push(text);
      }
    } else {
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        children.push(trimmed);
      }
    }
    this.pos++;
  }

  /**
   * Handle regular element parsing
   */
  private handleRegularElement(children: (RXMLNode | string)[]): void {
    const node = this.parseNode();
    children.push(node);

    // Handle processing instructions differently
    if (node.tagName[0] === "?") {
      children.push(...node.children);
      node.children = [];
    }
  }

  /**
   * Parse XML children recursively
   */
  parseChildren(tagName?: string): (RXMLNode | string)[] {
    const children: (RXMLNode | string)[] = [];
    let consumedToEnd = false;

    while (this.xmlString[this.pos]) {
      if (this.xmlString.charCodeAt(this.pos) === CharCodes.OPEN_BRACKET) {
        if (this.xmlString.charCodeAt(this.pos + 1) === CharCodes.SLASH) {
          // Closing tag
          const result = this.handleClosingTag(tagName, children);
          if (result !== null) {
            return result;
          }
        } else if (
          this.xmlString.charCodeAt(this.pos + 1) === CharCodes.EXCLAMATION
        ) {
          // Comment, CDATA, or DOCTYPE
          const wasConsumedToEnd = this.processSpecialContent(children);
          if (wasConsumedToEnd) {
            consumedToEnd = true;
          }
        } else {
          // Regular element
          this.handleRegularElement(children);
        }
      } else {
        // Text content
        this.handleTextContent(children);
      }
    }

    // Check for unclosed tags
    this.checkUnclosedTag(tagName, consumedToEnd);

    return children;
  }

  /**
   * Check if character is whitespace
   */
  private isWhitespace(code: number): boolean {
    return (
      code === CharCodes.SPACE ||
      code === CharCodes.TAB ||
      code === CharCodes.NEWLINE ||
      code === CharCodes.CARRIAGE_RETURN
    );
  }

  /**
   * Skip whitespace characters
   */
  private skipWhitespace(): void {
    while (
      this.pos < this.xmlString.length &&
      this.isWhitespace(this.xmlString.charCodeAt(this.pos))
    ) {
      this.pos++;
    }
  }

  /**
   * Parse attribute value
   */
  private parseAttributeValue(): string | null {
    if (this.pos >= this.xmlString.length || this.xmlString[this.pos] !== "=") {
      return null;
    }

    this.pos++; // Skip =
    this.skipWhitespace();

    const code = this.xmlString.charCodeAt(this.pos);
    if (code === CharCodes.SINGLE_QUOTE || code === CharCodes.DOUBLE_QUOTE) {
      const { value: parsedValue, newPos: valueEnd } = parseString(
        this.xmlString,
        this.pos
      );
      this.pos = valueEnd;
      return parsedValue;
    }

    return null;
  }

  /**
   * Parse single attribute
   */
  private parseAttribute(attributes: Record<string, string | null>): void {
    const { name: attrName, newPos: nameEnd } = parseName(
      this.xmlString,
      this.pos
    );
    this.pos = nameEnd;
    this.skipWhitespace();

    const value = this.parseAttributeValue();
    attributes[attrName] = value;
  }

  /**
   * Parse all attributes
   */
  private parseAttributes(): Record<string, string | null> {
    const attributes: Record<string, string | null> = {};

    while (
      this.xmlString.charCodeAt(this.pos) !== CharCodes.CLOSE_BRACKET &&
      this.xmlString[this.pos]
    ) {
      const c = this.xmlString.charCodeAt(this.pos);

      if (this.isWhitespace(c)) {
        this.pos++;
        continue;
      }

      if ((c > 64 && c < 91) || (c > 96 && c < 123)) {
        this.parseAttribute(attributes);
      } else {
        this.pos++;
      }
    }

    return attributes;
  }

  /**
   * Parse special tag content (script, style)
   */
  private parseSpecialTagContent(
    _tagName: string,
    closingTag: string
  ): (RXMLNode | string)[] {
    const start = this.pos + 1;
    this.pos = this.xmlString.indexOf(closingTag, this.pos);

    if (this.pos === -1) {
      const children = [this.xmlString.slice(start)];
      this.pos = this.xmlString.length;
      return children;
    }

    const children = [this.xmlString.slice(start, this.pos)];
    this.pos += closingTag.length;
    return children;
  }

  /**
   * Parse node children based on tag type
   */
  private parseNodeChildren(
    tagName: string,
    isSelfClosing: boolean
  ): (RXMLNode | string)[] {
    if (isSelfClosing) {
      this.pos++;
      return [];
    }

    if (tagName === "script") {
      return this.parseSpecialTagContent(tagName, "</script>");
    }

    if (tagName === "style") {
      return this.parseSpecialTagContent(tagName, "</style>");
    }

    if (this.options.noChildNodes?.indexOf(tagName) === -1) {
      this.pos++;
      return this.parseChildren(tagName);
    }

    // Tag is in noChildNodes
    this.pos++;
    if ((DEFAULT_NO_CHILD_NODES as readonly string[]).includes(tagName)) {
      return [];
    }

    // Custom noChildNodes tags might have closing tags to skip
    const closingTag = `</${tagName}>`;
    const closingPos = this.xmlString.indexOf(closingTag, this.pos);
    if (closingPos !== -1) {
      this.pos = closingPos + closingTag.length;
    }

    return [];
  }

  /**
   * Parse a single XML node
   */
  parseNode(): RXMLNode {
    this.pos++; // Skip opening <

    const { name: tagName, newPos } = parseName(this.xmlString, this.pos);
    this.pos = newPos;

    const attributes = this.parseAttributes();

    // Check for self-closing tag or processing instruction
    const isSelfClosing =
      this.xmlString.charCodeAt(this.pos - 1) === CharCodes.SLASH ||
      (tagName[0] === "?" &&
        this.xmlString.charCodeAt(this.pos - 1) === CharCodes.QUESTION);

    const children = this.parseNodeChildren(tagName, isSelfClosing);

    return { tagName, attributes, children };
  }

  /**
   * Parse text content until next tag
   */
  private parseText(): string {
    const start = this.pos;
    this.pos = this.xmlString.indexOf("<", this.pos) - 1;
    if (this.pos === -2) {
      this.pos = this.xmlString.length;
    }
    return this.xmlString.slice(start, this.pos + 1);
  }

  /**
   * Handle comments, CDATA, and DOCTYPE declarations
   */
  private handleSpecialContent(children: (RXMLNode | string)[]): void {
    if (this.xmlString.charCodeAt(this.pos + 2) === CharCodes.MINUS) {
      // Comment
      this.handleComment(children);
    } else if (
      this.xmlString.charCodeAt(this.pos + 2) ===
        CharCodes.OPEN_CORNER_BRACKET &&
      this.xmlString.charCodeAt(this.pos + 8) ===
        CharCodes.OPEN_CORNER_BRACKET &&
      this.xmlString.substr(this.pos + 3, 5).toLowerCase() === "cdata"
    ) {
      // CDATA
      this.handleCData(children);
    } else {
      // DOCTYPE or other declaration
      this.handleDoctype(children);
    }
  }

  /**
   * Handle XML comments
   */
  private handleComment(children: (RXMLNode | string)[]): void {
    const startCommentPos = this.pos;

    // Find comment end
    while (
      this.pos !== -1 &&
      !(
        this.xmlString.charCodeAt(this.pos) === CharCodes.CLOSE_BRACKET &&
        this.xmlString.charCodeAt(this.pos - 1) === CharCodes.MINUS &&
        this.xmlString.charCodeAt(this.pos - 2) === CharCodes.MINUS
      )
    ) {
      this.pos = this.xmlString.indexOf(">", this.pos + 1);
    }

    if (this.pos === -1) {
      this.pos = this.xmlString.length;
    }

    if (this.options.keepComments) {
      children.push(this.xmlString.substring(startCommentPos, this.pos + 1));
    }

    this.pos++;
  }

  /**
   * Handle CDATA sections
   */
  private handleCData(children: (RXMLNode | string)[]): void {
    const cdataEndIndex = this.xmlString.indexOf("]]>", this.pos);
    if (cdataEndIndex === -1) {
      // Unclosed CDATA - consume everything to the end
      children.push(this.xmlString.substr(this.pos + 9));
      this.pos = this.xmlString.length;
    } else {
      children.push(this.xmlString.substring(this.pos + 9, cdataEndIndex));
      this.pos = cdataEndIndex + 3;
    }
  }

  /**
   * Handle DOCTYPE declarations
   */
  private handleDoctype(children: (RXMLNode | string)[]): void {
    const startDoctype = this.pos + 1;
    this.pos += 2;
    let encapsulated = false;

    while (
      (this.xmlString.charCodeAt(this.pos) !== CharCodes.CLOSE_BRACKET ||
        encapsulated) &&
      this.xmlString[this.pos]
    ) {
      if (
        this.xmlString.charCodeAt(this.pos) === CharCodes.OPEN_CORNER_BRACKET
      ) {
        encapsulated = true;
      } else if (
        encapsulated &&
        this.xmlString.charCodeAt(this.pos) === CharCodes.CLOSE_CORNER_BRACKET
      ) {
        encapsulated = false;
      }
      this.pos++;
    }

    children.push(this.xmlString.substring(startDoctype, this.pos));
    this.pos++;
  }

  /**
   * Get current position
   */
  getPosition(): number {
    return this.pos;
  }

  /**
   * Set position
   */
  setPosition(pos: number): void {
    this.pos = pos;
  }
}
