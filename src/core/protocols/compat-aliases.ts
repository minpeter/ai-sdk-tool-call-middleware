import { kExaone2Protocol } from "./k-exaone-2-protocol";
import { kExaone236BProtocol } from "./k-exaone-236b-protocol";
import { isProtocolFactory } from "./protocol-interface";
import { qwen3CoderProtocol } from "./qwen3coder-protocol";

export const KExaone2ToolParser = kExaone2Protocol;
export const KExaone236BToolParser = kExaone236BProtocol;
export const isTCMProtocolFactory = isProtocolFactory;
export const Qwen3CoderToolParser = qwen3CoderProtocol;
export const uiTarsXmlProtocol = qwen3CoderProtocol;
