import type { TCMCoreProtocol } from "./protocol-interface";

export interface Glm5FastPaths {
  isDefinitelyPlainGeneratedText: (text: string) => boolean;
}

export interface Glm5MaterializedParser {
  fastPaths: Glm5FastPaths;
  parseGeneratedText: TCMCoreProtocol["parseGeneratedText"];
}

type Glm5Parser = TCMCoreProtocol["parseGeneratedText"];

const glm5FastPathRegistrations = new WeakMap<Glm5Parser, Glm5FastPaths>();

/**
 * Register the closed-over built-in parser without retaining its protocol
 * object. The function owns its GLM options and does not depend on `this`, so
 * an unchanged borrowed method has the same parsing semantics.
 */
export function registerGlm5FastPaths(
  parser: Glm5Parser,
  fastPaths: Glm5FastPaths
): void {
  if (!glm5FastPathRegistrations.has(parser)) {
    glm5FastPathRegistrations.set(parser, Object.freeze({ ...fastPaths }));
  }
}

/** Look up only an already-evaluated parser value; getters stay caller-owned. */
export function glm5FastPathsForParser(
  parser: unknown
): Glm5FastPaths | undefined {
  return typeof parser === "function"
    ? glm5FastPathRegistrations.get(parser as Glm5Parser)
    : undefined;
}

/** Compatibility helper for the retired invocation registry. */
export function materializeRegisteredGlm5Parser(
  protocol: TCMCoreProtocol
): Glm5MaterializedParser | undefined {
  const { parseGeneratedText } = protocol;
  const fastPaths = glm5FastPathsForParser(parseGeneratedText);
  return fastPaths ? { fastPaths, parseGeneratedText } : undefined;
}

/** Compatibility helper for the retired invocation registry. */
export function glm5FastPathsForProtocol(
  protocol: TCMCoreProtocol
): Glm5FastPaths | undefined {
  return glm5FastPathsForParser(protocol.parseGeneratedText);
}

export function hasRegisteredGlm5FastPaths(protocol: TCMCoreProtocol): boolean {
  return glm5FastPathsForProtocol(protocol) !== undefined;
}
