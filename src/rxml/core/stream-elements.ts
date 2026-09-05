import type { RXMLNode } from "./types";

export function visitStreamElements(
  node: RXMLNode | string,
  keepComments: boolean,
  emit: (element: RXMLNode | string) => void
): void {
  if (typeof node === "string") {
    if (keepComments && node.includes("<!--")) {
      emit(node);
    }
    return;
  }

  emit(node);
  for (const child of node.children) {
    visitStreamElements(child, keepComments, emit);
  }
}
