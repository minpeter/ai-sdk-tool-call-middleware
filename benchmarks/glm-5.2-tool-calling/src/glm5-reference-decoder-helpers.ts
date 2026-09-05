type PythonQuote = "'" | '"' | null;

interface LiteralScanStep {
  readonly escaped: boolean;
  readonly output: string;
  readonly quote: PythonQuote;
  readonly skippedCharacters: number;
}

const PYTHON_KEYWORD_PATTERN = /^(True|False|None)\b/u;
const PYTHON_KEYWORD_REPLACEMENTS: Readonly<Record<string, string>> = {
  False: "false",
  None: "null",
  True: "true",
};

function scanQuotedCharacter(
  character: string,
  quote: Exclude<PythonQuote, null>,
  escaped: boolean
): LiteralScanStep {
  if (escaped) {
    let output = `\\${character}`;
    if (quote === "'" && character === "'") {
      output = "'";
    } else if (character === '"') {
      output = '\\"';
    }
    return { escaped: false, output, quote, skippedCharacters: 0 };
  }
  if (character === "\\") {
    return { escaped: true, output: "", quote, skippedCharacters: 0 };
  }
  if (character === quote) {
    return { escaped: false, output: '"', quote: null, skippedCharacters: 0 };
  }
  const output = character === '"' ? '\\"' : character;
  return { escaped: false, output, quote, skippedCharacters: 0 };
}

function scanUnquotedCharacter(input: string, index: number): LiteralScanStep {
  const character = input.charAt(index);
  if (character === "'" || character === '"') {
    return {
      escaped: false,
      output: '"',
      quote: character,
      skippedCharacters: 0,
    };
  }
  const keyword = PYTHON_KEYWORD_PATTERN.exec(input.slice(index))?.[1];
  if (keyword) {
    return {
      escaped: false,
      output: PYTHON_KEYWORD_REPLACEMENTS[keyword] ?? keyword,
      quote: null,
      skippedCharacters: keyword.length - 1,
    };
  }
  let output = character;
  if (character === "(") {
    output = "[";
  } else if (character === ")") {
    output = "]";
  }
  return { escaped: false, output, quote: null, skippedCharacters: 0 };
}

/** Convert the bounded Python literals accepted by the pinned SGLang detector to JSON. */
export function pythonLiteralToJson(input: string): string | null {
  let output = "";
  let quote: PythonQuote = null;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const step: LiteralScanStep =
      quote === null
        ? scanUnquotedCharacter(input, index)
        : scanQuotedCharacter(input.charAt(index), quote, escaped);
    const {
      escaped: nextEscaped,
      output: fragment,
      quote: nextQuote,
      skippedCharacters,
    } = step;
    output += fragment;
    quote = nextQuote;
    escaped = nextEscaped;
    index += skippedCharacters;
  }
  return quote === null && !escaped ? output : null;
}
