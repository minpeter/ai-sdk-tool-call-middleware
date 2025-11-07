/* eslint-disable @typescript-eslint/no-explicit-any */
export async function collectSSE(
  url: string,
  body: unknown
): Promise<string[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.body) {
    return [];
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let idx: number = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.trim();
      if (line.startsWith("data:")) {
        chunks.push(line.substring(5).trim());
      }
      idx = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim().length > 0) {
    const line = buffer.trim();
    if (line.startsWith("data:")) {
      chunks.push(line.substring(5).trim());
    }
  }
  return chunks;
}

export function parseOpenAIChunk(line: string): unknown | "DONE" | undefined {
  if (line === "[DONE]") {
    return "DONE";
  }
  try {
    return JSON.parse(line);
  } catch {
    return;
  }
}
