/**
 * Error classes for robust-xml parser
 */

export class RXMLParseError extends Error {
  cause?: unknown;
  line?: number;
  column?: number;

  constructor(
    message: string,
    cause?: unknown,
    line?: number,
    column?: number
  ) {
    super(message);
    this.name = "RXMLParseError";
    this.cause = cause;
    this.line = line;
    this.column = column;
  }
}

export class RXMLDuplicateStringTagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RXMLDuplicateStringTagError";
  }
}

export class RXMLCoercionError extends Error {
  cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RXMLCoercionError";
    this.cause = cause;
  }
}

export class RXMLStringifyError extends Error {
  cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RXMLStringifyError";
    this.cause = cause;
  }
}

export class RXMLStreamError extends Error {
  cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RXMLStreamError";
    this.cause = cause;
  }
}
