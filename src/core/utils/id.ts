export function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

const TOOL_CALL_ID_PREFIX = "call_";
const TOOL_CALL_ID_BODY_LENGTH = 24;
const TOOL_CALL_ID_ALPHANUM =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomAlphaNumeric(length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const index = Math.floor(Math.random() * TOOL_CALL_ID_ALPHANUM.length);
    out += TOOL_CALL_ID_ALPHANUM[index] ?? "0";
  }
  return out;
}

export function generateToolCallId(): string {
  return `${TOOL_CALL_ID_PREFIX}${randomAlphaNumeric(TOOL_CALL_ID_BODY_LENGTH)}`;
}
