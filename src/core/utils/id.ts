export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 13);
}

const TOOL_CALL_ID_PREFIX = "call_";
const TOOL_CALL_ID_BODY_LENGTH = 24;
const TOOL_CALL_ID_ALPHANUM =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomAlphaNumeric(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const byte = bytes[i];
    const index = (byte ?? 0) % TOOL_CALL_ID_ALPHANUM.length;
    out += TOOL_CALL_ID_ALPHANUM[index] ?? "0";
  }
  return out;
}

export function generateToolCallId(): string {
  return `${TOOL_CALL_ID_PREFIX}${randomAlphaNumeric(TOOL_CALL_ID_BODY_LENGTH)}`;
}
