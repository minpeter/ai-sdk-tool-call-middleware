import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { QwenStreamCallState } from "./qwen3coder-stream-call-content";

export type StreamController =
  TransformStreamDefaultController<LanguageModelV4StreamPart>;
export type StreamingCallState = QwenStreamCallState;
export type ToolCallMode = "unknown" | "single" | "multi";

export interface ToolCallContainerState {
  activeCall: StreamingCallState | null;
  emittedToolCallCount: number;
  innerBuffer: string;
  mode: ToolCallMode;
  outerNameAttr: string | null;
  outerOpenTag: string;
  raw: string;
}
