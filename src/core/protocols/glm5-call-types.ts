import type { JSONObject } from "@ai-sdk/provider";

export type Glm5StringBoundaryNormalization = "layout" | "preserve";

export interface Glm5ProtocolOptions {
  /** Recover a final call whose closing structural tag was truncated. */
  recoverIncompleteToolCalls?: boolean;
  /** Recover uniquely matching case/punctuation variants of declared names. */
  recoverNames?: boolean;
  /**
   * Preserve a bounded bare code reference for an explicitly open object
   * schema. This matches GLM's raw-string argument grammar for handles such as
   * `responseData` without evaluating or completing arbitrary expressions.
   */
  recoverOpaqueObjectReferences?: boolean;
  /** Remove only newline-based XML layout indentation from string values. */
  stringBoundaryNormalization?: Glm5StringBoundaryNormalization;
}

export interface ResolvedGlm5ProtocolOptions {
  recoverIncompleteToolCalls: boolean;
  recoverNames: boolean;
  recoverOpaqueObjectReferences: boolean;
  stringBoundaryNormalization: Glm5StringBoundaryNormalization;
}

export interface ParsedGlm5Call {
  args: JSONObject;
  rawToolName: string;
  recoveries: string[];
  toolName: string;
}

export interface Glm5CallSnapshot extends ParsedGlm5Call {
  hasPartialValue: boolean;
}

export interface NameResolution {
  recovered: boolean;
  value: string;
}

export const MAX_GLM5_CALL_BODY_LENGTH = 1_048_576;

export function resolveGlm5ProtocolOptions(
  options?: Glm5ProtocolOptions
): ResolvedGlm5ProtocolOptions {
  return {
    recoverOpaqueObjectReferences:
      options?.recoverOpaqueObjectReferences !== false,
    recoverIncompleteToolCalls: options?.recoverIncompleteToolCalls !== false,
    recoverNames: options?.recoverNames !== false,
    stringBoundaryNormalization:
      options?.stringBoundaryNormalization ?? "layout",
  };
}
