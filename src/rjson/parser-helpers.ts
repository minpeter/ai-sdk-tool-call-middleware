import type { Token, TokenType } from "./lexer";

export interface ParseWarning {
  line: number;
  message: string;
}

export interface ParseState {
  duplicate: boolean;
  pos: number;
  reviver?: (key: string, value: unknown) => unknown;
  tolerant: boolean;
  warnings: ParseWarning[];
}

export interface ParseOptions {
  /**
   * Allow duplicate object keys in JSON.
   * - true: Allow duplicates (uses last value, like native JSON.parse)
   * - false: Reject duplicates with error (enforces JSON specification)
   * @default false
   */
  duplicate?: boolean;
  /**
   * Enable relaxed JSON syntax parsing (unquoted keys, single quotes, trailing commas, comments)
   * @default true
   */
  relaxed?: boolean;
  /**
   * Optional reviver function to transform parsed values (same as JSON.parse reviver)
   */
  reviver?: (key: string, value: unknown) => unknown;
  /**
   * Continue parsing when encountering recoverable errors, collecting warnings.
   * @default false
   */
  tolerant?: boolean;
  /**
   * Collect parsing warnings instead of throwing immediately. Implies tolerant mode.
   * @default false
   */
  warnings?: boolean;
}

export interface ParseManyOpts<T> {
  elementName: string;
  elementParser: (tokens: Token[], state: ParseState, obj: T) => void;
  endSymbol: TokenType;
  skip: TokenType[];
}

export function popToken(tokens: Token[], state: ParseState): Token {
  const token = tokens[state.pos];
  state.pos += 1;

  if (!token) {
    const lastLine = tokens.length === 0 ? 1 : (tokens.at(-1)?.line ?? 1);
    return { type: "eof", match: "", value: undefined, line: lastLine };
  }

  return token;
}

export function strToken(token: Token): string {
  switch (token.type) {
    case "atom":
    case "string":
    case "number":
      return `${token.type} ${token.match}`;
    case "eof":
      return "end-of-file";
    default:
      return `'${token.type}'`;
  }
}

export function skipColon(tokens: Token[], state: ParseState): void {
  const colon = popToken(tokens, state);
  if (colon.type !== ":") {
    const message = `Unexpected token: ${strToken(colon)}, expected ':'`;
    if (state.tolerant) {
      state.warnings.push({
        message,
        line: colon.line,
      });
      state.pos -= 1;
    } else {
      const err = new SyntaxError(message);
      (err as { line?: number }).line = colon.line;
      throw err;
    }
  }
}

export function skipPunctuation(
  tokens: Token[],
  state: ParseState,
  valid?: TokenType[]
): Token {
  const punctuation: TokenType[] = [",", ":", "]", "}"];
  let token = popToken(tokens, state);

  while (true) {
    if (valid?.includes(token.type)) {
      return token;
    }
    if (token.type === "eof") {
      return token;
    }
    if (punctuation.includes(token.type)) {
      const message = `Unexpected token: ${strToken(
        token
      )}, expected '[', '{', number, string or atom`;
      if (state.tolerant) {
        state.warnings.push({
          message,
          line: token.line,
        });
        token = popToken(tokens, state);
      } else {
        const err = new SyntaxError(message);
        (err as { line?: number }).line = token.line;
        throw err;
      }
    } else {
      return token;
    }
  }
}

export function raiseError(
  state: ParseState,
  token: Token,
  message: string
): void {
  if (state.tolerant) {
    state.warnings.push({
      message,
      line: token.line,
    });
  } else {
    const err = new SyntaxError(message);
    (err as { line?: number }).line = token.line;
    throw err;
  }
}

export function raiseUnexpected(
  state: ParseState,
  token: Token,
  expected: string
): void {
  raiseError(
    state,
    token,
    `Unexpected token: ${strToken(token)}, expected ${expected}`
  );
}

export function checkDuplicates(
  state: ParseState,
  obj: { [key: string]: unknown },
  token: Token
): void {
  const key = String(token.value);
  if (!state.duplicate && Object.hasOwn(obj, key)) {
    raiseError(state, token, `Duplicate key: ${key}`);
  }
}

function defineObjectProperty(
  obj: Record<string, unknown>,
  propertyKey: string,
  value: unknown
): void {
  Object.defineProperty(obj, propertyKey, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export function appendPair(
  state: ParseState,
  obj: { [objKey: string]: unknown },
  key: string,
  value: unknown
): void {
  const finalValue = state.reviver ? state.reviver(key, value) : value;
  if (finalValue !== undefined) {
    defineObjectProperty(obj, key, finalValue);
  }
}

function handleInvalidToken<T>(
  token: Token,
  state: ParseState,
  opts: ParseManyOpts<T>,
  result: T
): T | null {
  raiseUnexpected(state, token, `',' or '${opts.endSymbol}'`);

  if (state.tolerant) {
    if (token.type === "eof") {
      return result;
    }
    state.pos -= 1;
    return null;
  }
  return result;
}

function handleCommaToken<T>(params: {
  opts: ParseManyOpts<T>;
  result: T;
  state: ParseState;
  token: Token;
  tokens: Token[];
}): T | null {
  const { token, tokens, state, opts, result } = params;
  const nextToken = tokens[state.pos];
  if (state.tolerant && nextToken && nextToken.type === opts.endSymbol) {
    raiseError(state, token, `Trailing comma before '${opts.endSymbol}'`);
    popToken(tokens, state);
    return result;
  }
  opts.elementParser(tokens, state, result);
  return null;
}

function parseManyInitialElement<T>(
  tokens: Token[],
  state: ParseState,
  result: T,
  opts: ParseManyOpts<T>
): T | undefined {
  const token = skipPunctuation(tokens, state, opts.skip);

  if (token.type === "eof") {
    raiseUnexpected(state, token, `'${opts.endSymbol}' or ${opts.elementName}`);
    return result;
  }

  if (token.type === opts.endSymbol) {
    return result;
  }

  state.pos -= 1;
  opts.elementParser(tokens, state, result);
}

function parseManyProcessToken<T>(params: {
  token: Token;
  tokens: Token[];
  state: ParseState;
  opts: ParseManyOpts<T>;
  result: T;
}): T | undefined {
  const { token, tokens, state, opts, result } = params;
  if (token.type !== opts.endSymbol && token.type !== ",") {
    const handledResult = handleInvalidToken(token, state, opts, result);
    if (handledResult !== null) {
      return handledResult;
    }
  }

  if (token.type === opts.endSymbol) {
    return result;
  }

  if (token.type === ",") {
    const handledResult = handleCommaToken({
      token,
      tokens,
      state,
      opts,
      result,
    });
    if (handledResult !== null) {
      return handledResult;
    }
    return;
  }

  opts.elementParser(tokens, state, result);
}

export function parseMany<T>(
  tokens: Token[],
  state: ParseState,
  result: T,
  opts: ParseManyOpts<T>
): T {
  const initialResult = parseManyInitialElement(tokens, state, result, opts);
  if (initialResult !== undefined) {
    return initialResult;
  }

  while (true) {
    const token = popToken(tokens, state);
    const processedResult = parseManyProcessToken({
      token,
      tokens,
      state,
      opts,
      result,
    });
    if (processedResult !== undefined) {
      return processedResult;
    }
  }
}

export function endChecks(
  tokens: Token[],
  state: ParseState,
  ret: unknown
): void {
  if (state.pos < tokens.length) {
    if (state.tolerant) {
      skipPunctuation(tokens, state);
    }
    if (state.pos < tokens.length) {
      raiseError(
        state,
        tokens[state.pos],
        `Unexpected token: ${strToken(tokens[state.pos])}, expected end-of-input`
      );
    }
  }

  if (state.tolerant && state.warnings.length > 0) {
    const message =
      state.warnings.length === 1
        ? state.warnings[0].message
        : `${state.warnings.length} parse warnings`;
    const err = new SyntaxError(message);
    (err as { line?: number; warnings?: ParseWarning[]; obj?: unknown }).line =
      state.warnings[0].line;
    (
      err as { line?: number; warnings?: ParseWarning[]; obj?: unknown }
    ).warnings = state.warnings;
    (err as { line?: number; warnings?: ParseWarning[]; obj?: unknown }).obj =
      ret;
    throw err;
  }
}
