const BODY_BLOCK_LENGTH = 4096;

export type Glm5StreamBodyMaterializationObserver = (
  characters: number
) => void;

export interface Glm5StreamBody {
  blocks: string[];
  flat: string | null;
  flatAtLength: number;
  length: number;
  observer?: Glm5StreamBodyMaterializationObserver;
  pendingLength: number;
  pendingParts: string[];
}

function flushPendingBlock(body: Glm5StreamBody): void {
  if (body.pendingLength === 0) {
    return;
  }
  const block = body.pendingParts.join("");
  body.observer?.(block.length);
  body.blocks.push(block);
  body.pendingLength = 0;
  body.pendingParts.length = 0;
}

export function createGlm5StreamBody(
  initial = "",
  observer?: Glm5StreamBodyMaterializationObserver
): Glm5StreamBody {
  const body: Glm5StreamBody = {
    blocks: [],
    flat: "",
    flatAtLength: 0,
    length: 0,
    observer,
    pendingLength: 0,
    pendingParts: [],
  };
  appendGlm5StreamBody(body, initial);
  return body;
}

export function appendGlm5StreamBody(
  body: Glm5StreamBody,
  value: string
): void {
  let offset = 0;
  while (offset < value.length) {
    const available = BODY_BLOCK_LENGTH - body.pendingLength;
    const next = value.slice(offset, offset + available);
    body.pendingParts.push(next);
    body.pendingLength += next.length;
    body.length += next.length;
    offset += next.length;
    body.flat = null;
    if (body.pendingLength === BODY_BLOCK_LENGTH) {
      flushPendingBlock(body);
    }
  }
}

export function materializeGlm5StreamBody(body: Glm5StreamBody): string {
  if (body.flat !== null && body.flatAtLength === body.length) {
    return body.flat;
  }
  flushPendingBlock(body);
  body.flat = body.blocks.join("");
  body.flatAtLength = body.length;
  body.observer?.(body.flat.length);
  return body.flat;
}

export function sliceGlm5StreamBody(
  body: Glm5StreamBody,
  start: number,
  end?: number
): string {
  return materializeGlm5StreamBody(body).slice(start, end);
}

export function truncateGlm5StreamBody(
  body: Glm5StreamBody,
  end: number
): void {
  const prefix = sliceGlm5StreamBody(body, 0, end);
  body.blocks.length = 0;
  body.pendingParts.length = 0;
  body.pendingLength = 0;
  body.length = prefix.length;
  body.flat = prefix;
  body.flatAtLength = prefix.length;
  if (prefix.length > 0) {
    body.blocks.push(prefix);
  }
}

export function clearGlm5StreamBody(body: Glm5StreamBody): void {
  body.blocks.length = 0;
  body.pendingParts.length = 0;
  body.pendingLength = 0;
  body.length = 0;
  body.flat = "";
  body.flatAtLength = 0;
}
