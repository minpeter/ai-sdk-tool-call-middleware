import { createLexer, type Token } from "./lexer-tokenizer";

export type { Token, TokenType } from "./lexer-tokenizer";

export const lexer = createLexer(true);
export const strictLexer = createLexer(false);

function previousSignificantToken(
  tokens: Token[],
  index: number
): number | undefined {
  let currentIndex = index;
  for (; currentIndex >= 0; currentIndex -= 1) {
    if (tokens[currentIndex].type !== " ") {
      return currentIndex;
    }
  }
}

export function stripTrailingComma(tokens: Token[]): Token[] {
  const result: Token[] = [];

  tokens.forEach((token, index) => {
    if (index > 0 && (token.type === "]" || token.type === "}")) {
      const commaIndex = previousSignificantToken(result, result.length - 1);
      if (commaIndex !== undefined && result[commaIndex].type === ",") {
        const valueIndex = previousSignificantToken(result, commaIndex - 1);
        if (
          valueIndex !== undefined &&
          result[valueIndex].type !== "[" &&
          result[valueIndex].type !== "{"
        ) {
          result[commaIndex] = {
            type: " ",
            match: " ",
            value: undefined,
            line: result[commaIndex].line,
          };
        }
      }
    }

    result.push(token);
  });

  return result;
}

/**
 * Transform relaxed JSON syntax to standard JSON text.
 *
 * Converts unquoted keys, single quotes, trailing commas, and comments into
 * syntax accepted by a native JSON parser.
 */
export function transform(text: string): string {
  return stripTrailingComma(lexer(text)).reduce(
    (result, token) => result + token.match,
    ""
  );
}
