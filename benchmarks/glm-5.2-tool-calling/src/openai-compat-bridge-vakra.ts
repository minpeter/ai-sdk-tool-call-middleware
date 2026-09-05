import {
  isTransientUpstreamError as classifyTransientUpstreamError,
  createCliCapturePolicy,
  createOpenAICompatGenerate as createSharedGenerate,
  bridgeArmFromModel as parseBridgeArm,
  parseOpenAICompatRequest as parseSharedRequest,
  runOpenAICompatBridgeCliWhenMain,
  type OpenAICompatBridgeArm as SharedBridgeArm,
  type OpenAICompatBridgeOptions as SharedBridgeOptions,
  type RunningOpenAICompatBridge as SharedRunningBridge,
} from "./openai-compat-bridge";
import { createStartOpenAICompatBridge } from "./openai-compat-bridge-shared";
import {
  credentialSafeError,
  credentialSafeText,
  ProviderCapture,
} from "./provider-capture-vakra-linear";

export type OpenAICompatBridgeArm = SharedBridgeArm;
export interface OpenAICompatBridgeOptions extends SharedBridgeOptions {}
export interface RunningOpenAICompatBridge extends SharedRunningBridge {}

export const bridgeArmFromModel = parseBridgeArm;
export const createOpenAICompatGenerate = createSharedGenerate;
export const isTransientUpstreamError = classifyTransientUpstreamError;
export const parseOpenAICompatRequest = parseSharedRequest;

const capturePolicy = createCliCapturePolicy(
  ProviderCapture,
  credentialSafeError,
  credentialSafeText
);

export const startOpenAICompatBridge =
  createStartOpenAICompatBridge(capturePolicy);

runOpenAICompatBridgeCliWhenMain(import.meta.url, capturePolicy);
