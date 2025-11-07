export function generateResponseId(): string {
  return `chatcmpl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}
