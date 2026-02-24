const XML_TAG_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

export function isValidXmlTagName(name: string): boolean {
  return XML_TAG_NAME_REGEX.test(name);
}

export function toSafeXmlTagName(name: string): string {
  return isValidXmlTagName(name) ? name : "tool";
}
