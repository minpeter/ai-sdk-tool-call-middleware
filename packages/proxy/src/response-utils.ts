export function generateResponseId(): string {
  return `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}
