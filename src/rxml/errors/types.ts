/**
 * Error classes for robust-xml parser
 */

export class RXMLParseError extends Error {
  line?: number;
  column?: number;

  constructor(message: string, cause?: Error, line?: number, column?: number) {
    super(message, cause ? { cause } : undefined);
    this.name = "RXMLParseError";
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
  constructor(message: string, cause?: Error) {
    super(message, cause ? { cause } : undefined);
    this.name = "RXMLCoercionError";
  }
}

export class RXMLStringifyError extends Error {
  constructor(message: string, cause?: Error) {
    super(message, cause ? { cause } : undefined);
    this.name = "RXMLStringifyError";
  }
}

export class RXMLStreamError extends Error {
  constructor(message: string, cause?: Error) {
    super(message, cause ? { cause } : undefined);
    this.name = "RXMLStreamError";
  }
}
