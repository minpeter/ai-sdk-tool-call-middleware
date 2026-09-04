import { decodeJsonStringLiteral } from "./json-string-decoder";

const WHITESPACE_TEST_REGEX = /\s/;
const WHITESPACE_REGEX = /\s+/y;
const OBJECT_START_REGEX = /\{/y;
const OBJECT_END_REGEX = /\}/y;
const ARRAY_START_REGEX = /\[/y;
const ARRAY_END_REGEX = /\]/y;
const COMMA_REGEX = /,/y;
const COLON_REGEX = /:/y;
const KEYWORD_REGEX = /(?:true|false|null)/y;
const NUMBER_REGEX = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const STRING_DOUBLE_REGEX = /"(?:[^"\\]|\\["bnrtf\\/]|\\u[0-9a-fA-F]{4})*"/y;
const STRING_SINGLE_REGEX = /'((?:[^'\\]|\\['bnrtf\\/]|\\u[0-9a-fA-F]{4})*)'/y;
const COMMENT_SINGLE_REGEX = /\/\/.*?(?:\r\n|\r|\n)/y;
const COMMENT_MULTI_REGEX = /\/\*[\s\S]*?\*\//y;
const IDENTIFIER_REGEX = /[$a-zA-Z0-9_\-+.*?!|&%^/#\\]+/y;

export type TokenType =
  | "atom"
  | "number"
  | "string"
  | "["
  | "]"
  | "{"
  | "}"
  | ":"
  | ","
  | " "
  | "eof";

interface RawToken {
  match: string;
  type: TokenType;
  value?: string | number | boolean | null;
}

export type Token = RawToken & {
  line: number;
};

interface TokenSpec {
  readonly createToken: (match: RegExpExecArray) => RawToken;
  readonly regex: RegExp;
}

function countNewlines(text: string): number {
  let count = 0;
  let index = text.indexOf("\n");
  while (index !== -1) {
    count += 1;
    index = text.indexOf("\n", index + 1);
  }
  return count;
}

function createSingleQuotedStringToken(matchResult: RegExpExecArray): RawToken {
  const content = matchResult[1].replace(
    /([^'\\]|\\['bnrtf\\]|\\u[0-9a-fA-F]{4})/g,
    (segment) => {
      if (segment === '"') {
        return '\\"';
      }
      return segment === "\\'" ? "'" : segment;
    }
  );
  const normalizedLiteral = `"${content}"`;
  const value = decodeJsonStringLiteral(normalizedLiteral);
  if (typeof value !== "string") {
    throw new SyntaxError("RJSON string token did not decode to a string");
  }
  return { match: normalizedLiteral, type: "string", value };
}

function createDoubleQuotedStringToken(match: RegExpExecArray): RawToken {
  const value = decodeJsonStringLiteral(match[0]);
  if (typeof value !== "string") {
    throw new SyntaxError("RJSON string token did not decode to a string");
  }
  return { match: match[0], type: "string", value };
}

function createIdentifierToken(matchResult: RegExpExecArray): RawToken {
  const [value] = matchResult;
  const match = `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return { match, type: "string", value };
}

function createCommentToken(matchResult: RegExpExecArray): RawToken {
  const match = matchResult[0].replace(/./g, (character) =>
    WHITESPACE_TEST_REGEX.test(character) ? character : " "
  );
  return { match, type: " ", value: undefined };
}

function createNumberToken(match: RegExpExecArray): RawToken {
  return {
    match: match[0],
    type: "number",
    value: Number.parseFloat(match[0]),
  };
}

function createKeywordToken(match: RegExpExecArray): RawToken {
  let value: null | boolean;
  switch (match[0]) {
    case "null":
      value = null;
      break;
    case "true":
      value = true;
      break;
    case "false":
      value = false;
      break;
    default:
      throw new Error(`Unexpected keyword: ${match[0]}`);
  }
  return { match: match[0], type: "atom", value };
}

function createSimpleToken(type: TokenType) {
  return (match: RegExpExecArray): RawToken => ({
    match: match[0],
    type,
    value: undefined,
  });
}

function createTokenSpecs(relaxed: boolean): readonly TokenSpec[] {
  const strictSpecs: readonly TokenSpec[] = [
    { regex: WHITESPACE_REGEX, createToken: createSimpleToken(" ") },
    { regex: OBJECT_START_REGEX, createToken: createSimpleToken("{") },
    { regex: OBJECT_END_REGEX, createToken: createSimpleToken("}") },
    { regex: ARRAY_START_REGEX, createToken: createSimpleToken("[") },
    { regex: ARRAY_END_REGEX, createToken: createSimpleToken("]") },
    { regex: COMMA_REGEX, createToken: createSimpleToken(",") },
    { regex: COLON_REGEX, createToken: createSimpleToken(":") },
    { regex: KEYWORD_REGEX, createToken: createKeywordToken },
    { regex: NUMBER_REGEX, createToken: createNumberToken },
    { regex: STRING_DOUBLE_REGEX, createToken: createDoubleQuotedStringToken },
  ];
  if (!relaxed) {
    return strictSpecs;
  }
  return [
    ...strictSpecs,
    { regex: STRING_SINGLE_REGEX, createToken: createSingleQuotedStringToken },
    { regex: COMMENT_SINGLE_REGEX, createToken: createCommentToken },
    { regex: COMMENT_MULTI_REGEX, createToken: createCommentToken },
    { regex: IDENTIFIER_REGEX, createToken: createIdentifierToken },
  ];
}

export function createLexer(relaxed: boolean): (contents: string) => Token[] {
  const tokenSpecs = createTokenSpecs(relaxed);
  return (contents: string): Token[] => {
    const tokens: Token[] = [];
    let line = 1;
    let position = 0;
    while (position < contents.length) {
      let token: Token | undefined;
      for (const tokenSpec of tokenSpecs) {
        tokenSpec.regex.lastIndex = position;
        const match = tokenSpec.regex.exec(contents);
        if (match !== null) {
          position += match[0].length;
          token = { ...tokenSpec.createToken(match), line };
          line += countNewlines(match[0]);
          break;
        }
      }
      if (token === undefined) {
        const error = new SyntaxError(
          `Unexpected character: ${contents[position]}; input: ${contents.slice(position, position + 100)}`
        );
        throw Object.assign(error, { line });
      }
      tokens.push(token);
    }
    return tokens;
  };
}
