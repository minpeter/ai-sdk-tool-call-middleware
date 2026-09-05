const HEX_CODE_UNIT_REGEX = /^[0-9a-fA-F]{4}$/;
const MAX_UNESCAPED_CONTROL_CODE_UNIT = 0x1f;

export function decodeJsonStringLiteral(literal: string): string {
  const contentEnd = literal.length - 1;
  if (contentEnd < 1 || literal[0] !== '"' || literal[contentEnd] !== '"') {
    throw new SyntaxError("Invalid JSON string literal delimiters");
  }

  let decoded = "";
  let index = 1;
  while (index < contentEnd) {
    const character = literal[index];
    if (character === '"') {
      throw new SyntaxError("Unescaped quote in JSON string literal");
    }
    if (character !== "\\") {
      if (character.charCodeAt(0) <= MAX_UNESCAPED_CONTROL_CODE_UNIT) {
        throw new SyntaxError(
          "Unescaped control character in JSON string literal"
        );
      }
      decoded += character;
      index += 1;
      continue;
    }

    const escapeIndex = index + 1;
    if (escapeIndex >= contentEnd) {
      throw new SyntaxError("Incomplete JSON string escape");
    }

    const escapeCode = literal[escapeIndex];
    switch (escapeCode) {
      case '"':
      case "\\":
      case "/":
        decoded += escapeCode;
        index += 2;
        break;
      case "b":
        decoded += "\b";
        index += 2;
        break;
      case "f":
        decoded += "\f";
        index += 2;
        break;
      case "n":
        decoded += "\n";
        index += 2;
        break;
      case "r":
        decoded += "\r";
        index += 2;
        break;
      case "t":
        decoded += "\t";
        index += 2;
        break;
      case "u": {
        const codeUnitEnd = index + 6;
        const hexadecimal = literal.slice(index + 2, codeUnitEnd);
        if (
          codeUnitEnd > contentEnd ||
          !HEX_CODE_UNIT_REGEX.test(hexadecimal)
        ) {
          throw new SyntaxError(
            "Invalid Unicode escape in JSON string literal"
          );
        }
        decoded += String.fromCharCode(Number.parseInt(hexadecimal, 16));
        index = codeUnitEnd;
        break;
      }
      default:
        throw new SyntaxError("Invalid JSON string escape");
    }
  }

  return decoded;
}
