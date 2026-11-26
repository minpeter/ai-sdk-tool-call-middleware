import { escapeRegExp as sharedEscapeRegExp } from "../../shared/regex";

export function escapeRegExp(literal: string): string {
  return sharedEscapeRegExp(literal);
}
