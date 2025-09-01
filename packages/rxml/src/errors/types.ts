/**
 * Error classes for robust-xml parser
 */

export class RXMLParseError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
    public line?: number,
    public column?: number
  ) {
    super(message);
    this.name = "RXMLParseError";
  }
}

export class RXMLDuplicateStringTagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RXMLDuplicateStringTagError";
  }
}

export class RXMLCoercionError extends Error {
  constructor(
    message: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = "RXMLCoercionError";
  }
}

export class RXMLStringifyError extends Error {
  constructor(
    message: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = "RXMLStringifyError";
  }
}

export class RXMLStreamError extends Error {
  constructor(
    message: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = "RXMLStreamError";
  }
}
