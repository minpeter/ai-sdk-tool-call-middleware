const XML_SELF_CLOSING_ROOT_WITH_BODY_REGEX =
  /^<([A-Za-z_][A-Za-z0-9_-]*)\s*\n([\s\S]+?)\n\s*\/>\s*$/;

export function tryRepairXmlSelfClosingRootWithBody(
  rawText: string,
  toolNames: string[]
): string | null {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const match = trimmed.match(XML_SELF_CLOSING_ROOT_WITH_BODY_REGEX);
  if (!match) {
    return null;
  }

  const rootTag = match[1];
  if (!toolNames.includes(rootTag)) {
    return null;
  }

  // Keep leading indentation intact for YAML payloads.
  const body = match[2].trimEnd();
  if (body.trim().length === 0 || body.includes(`</${rootTag}>`)) {
    return null;
  }

  return `<${rootTag}>\n${body}\n</${rootTag}>`;
}
