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
   * Parse XML children recursively
   */
  public parseChildren(tagName?: string): (RXMLNode | string)[] {
    const children: (RXMLNode | string)[] = [];
    let consumedToEnd = false;

    while (this.xmlString[this.pos]) {
      if (this.xmlString.charCodeAt(this.pos) === CharCodes.OPEN_BRACKET) {
        if (this.xmlString.charCodeAt(this.pos + 1) === CharCodes.SLASH) {
          // Closing tag
          const closeStart = this.pos + 2;
          this.pos = this.xmlString.indexOf(">", this.pos);

          const closeTag = this.xmlString.substring(closeStart, this.pos);
          if (tagName && closeTag.trim() !== tagName) {
            // Mismatched closing tag - throw error with context
            const { line, column } = getLineColumn(this.xmlString, this.pos);
            throw new RXMLParseError(
              `Unexpected close tag at line ${line}, column ${column}. Expected </${tagName}>, found </${closeTag}>`,
              undefined,
              line,
              column
            );
          }

          if (this.pos !== -1) this.pos += 1;
          return children;
        }
        if (this.xmlString.charCodeAt(this.pos + 1) === CharCodes.EXCLAMATION) {
          // Comment, CDATA, or DOCTYPE
          const prevPos = this.pos;
          this.handleSpecialContent(children);
          // Check if handleSpecialContent consumed everything to the end
          if (
            this.pos >= this.xmlString.length &&
            prevPos < this.xmlString.length
          ) {
            consumedToEnd = true;
          }
        } else {
          // Regular element
          const node = this.parseNode();
          children.push(node);

          // Handle processing instructions differently
          if (node.tagName[0] === "?") {
            children.push(...node.children);
            node.children = [];
          }
        }
      } else {
        // Text content
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
    }

    // Check for unclosed tags - if we've reached the end and still have a tagName, it's unclosed
    // But don't throw if special content (like unclosed CDATA) consumed everything to the end
    if (tagName && this.pos >= this.xmlString.length && !consumedToEnd) {
      const { line, column } = getLineColumn(this.xmlString, this.pos - 1);
      throw new RXMLParseError(
        `Unclosed tag at line ${line}, column ${column}. Expected closing tag </${tagName}>`,
        undefined,
        line,
        column
      );
    }

    return children;
  }

  /**
   * Parse a single XML node
   */
  public parseNode(): RXMLNode {
    this.pos++; // Skip opening <

    const { name: tagName, newPos } = parseName(this.xmlString, this.pos);
    this.pos = newPos;

    const attributes: Record<string, string | null> = {};
    let children: (RXMLNode | string)[] = [];

    // Parse attributes
    while (
      this.xmlString.charCodeAt(this.pos) !== CharCodes.CLOSE_BRACKET &&
      this.xmlString[this.pos]
    ) {
      const c = this.xmlString.charCodeAt(this.pos);

      // Skip whitespace
      if (
        c === CharCodes.SPACE ||
        c === CharCodes.TAB ||
        c === CharCodes.NEWLINE ||
        c === CharCodes.CARRIAGE_RETURN
      ) {
        this.pos++;
        continue;
      }

      if ((c > 64 && c < 91) || (c > 96 && c < 123)) {
        // Attribute name
        const { name: attrName, newPos: nameEnd } = parseName(
          this.xmlString,
          this.pos
        );
        this.pos = nameEnd;

        // Skip whitespace before =
        while (
          this.pos < this.xmlString.length &&
          (this.xmlString.charCodeAt(this.pos) === CharCodes.SPACE ||
            this.xmlString.charCodeAt(this.pos) === CharCodes.TAB ||
            this.xmlString.charCodeAt(this.pos) === CharCodes.NEWLINE ||
            this.xmlString.charCodeAt(this.pos) === CharCodes.CARRIAGE_RETURN)
        ) {
          this.pos++;
        }

        let value: string | null = null;
        if (
          this.pos < this.xmlString.length &&
          this.xmlString[this.pos] === "="
        ) {
          this.pos++; // Skip =

          // Skip whitespace after =
          while (
            this.pos < this.xmlString.length &&
            (this.xmlString.charCodeAt(this.pos) === CharCodes.SPACE ||
              this.xmlString.charCodeAt(this.pos) === CharCodes.TAB ||
              this.xmlString.charCodeAt(this.pos) === CharCodes.NEWLINE ||
              this.xmlString.charCodeAt(this.pos) === CharCodes.CARRIAGE_RETURN)
          ) {
            this.pos++;
          }

          const code = this.xmlString.charCodeAt(this.pos);
          if (
            code === CharCodes.SINGLE_QUOTE ||
            code === CharCodes.DOUBLE_QUOTE
          ) {
            const { value: parsedValue, newPos: valueEnd } = parseString(
              this.xmlString,
              this.pos
            );
            value = parsedValue;
            this.pos = valueEnd;
          }
        }

        attributes[attrName] = value;
      } else {
        // Unknown character, skip it
        this.pos++;
      }
    }

    // Check for self-closing tag or processing instruction
    const isSelfClosing =
      this.xmlString.charCodeAt(this.pos - 1) === CharCodes.SLASH ||
      (tagName[0] === "?" &&
        this.xmlString.charCodeAt(this.pos - 1) === CharCodes.QUESTION);

    if (isSelfClosing) {
      this.pos++;
    } else if (tagName === "script") {
      // Special handling for script tags
      const start = this.pos + 1;
      this.pos = this.xmlString.indexOf("</script>", this.pos);
      if (this.pos === -1) {
        // Unclosed script tag - extract content to end
        children = [this.xmlString.slice(start)];
        this.pos = this.xmlString.length;
      } else {
        children = [this.xmlString.slice(start, this.pos)];
        this.pos += 9;
      }
    } else if (tagName === "style") {
      // Special handling for style tags
      const start = this.pos + 1;
      this.pos = this.xmlString.indexOf("</style>", this.pos);
      if (this.pos === -1) {
        // Unclosed style tag - extract content to end
        children = [this.xmlString.slice(start)];
        this.pos = this.xmlString.length;
      } else {
        children = [this.xmlString.slice(start, this.pos)];
        this.pos += 8;
      }
    } else if (this.options.noChildNodes?.indexOf(tagName) === -1) {
      // Parse children for non-self-closing tags
      this.pos++;
      children = this.parseChildren(tagName);
    } else {
      // Tag is in noChildNodes - handle based on whether it's a default HTML self-closing tag
      this.pos++;
      if ((DEFAULT_NO_CHILD_NODES as readonly string[]).includes(tagName)) {
        // HTML self-closing tags don't have closing tags
        // Position is already correct
      } else {
        // Custom noChildNodes tags might have closing tags to skip
        const closingTag = `</${tagName}>`;
        const closingPos = this.xmlString.indexOf(closingTag, this.pos);
        if (closingPos !== -1) {
          this.pos = closingPos + closingTag.length;
        }
        // If no closing tag found, leave position as is
      }
    }

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
  public getPosition(): number {
    return this.pos;
  }

  /**
   * Set position
   */
  public setPosition(pos: number): void {
    this.pos = pos;
  }
}
