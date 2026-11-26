import type { TCMCoreProtocol } from "./protocol-interface";

export interface ProtocolGeneratedTextFastPaths {
  isDefinitelyPlainGeneratedText: (text: string) => boolean;
}

type GeneratedTextParser = TCMCoreProtocol["parseGeneratedText"];

const generatedTextFastPathRegistrations = new WeakMap<
  GeneratedTextParser,
  ProtocolGeneratedTextFastPaths
>();

/**
 * Register a closed-over built-in parser without retaining its protocol
 * object. Registered parsers must own their options without depending on
 * `this`, so an unchanged borrowed method preserves identical semantics.
 */
export function registerProtocolGeneratedTextFastPaths(
  parser: GeneratedTextParser,
  fastPaths: ProtocolGeneratedTextFastPaths
): void {
  if (!generatedTextFastPathRegistrations.has(parser)) {
    generatedTextFastPathRegistrations.set(
      parser,
      Object.freeze({ ...fastPaths })
    );
  }
}

/** Look up only an already-evaluated parser value; getters stay caller-owned. */
export function getProtocolGeneratedTextFastPaths(
  parser: unknown
): ProtocolGeneratedTextFastPaths | undefined {
  return typeof parser === "function"
    ? generatedTextFastPathRegistrations.get(parser as GeneratedTextParser)
    : undefined;
}
