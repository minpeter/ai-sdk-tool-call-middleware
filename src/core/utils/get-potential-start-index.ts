/**
 * Returns the index of the start of the searchedText in the text, or null if it
 * is not found.
 * ref: https://github.com/vercel/ai/blob/452bf12f0be9cb398d4af85a006bca13c8ce36d8/packages/ai/core/util/get-potential-start-index.ts
 */
export function getPotentialStartIndex(
  text: string,
  searchedText: string
): number | null {
  // Return null immediately if searchedText is empty.
  if (searchedText.length === 0) {
    return null;
  }

  // Check if the searchedText exists as a direct substring of text.
  const directIndex = text.indexOf(searchedText);
  if (directIndex !== -1) {
    return directIndex;
  }

  // Otherwise, look for the largest suffix of "text" that matches
  // a prefix of "searchedText". We only need to check suffixes that
  // are shorter than searchedText, as we already checked for a direct
  // match with indexOf.
  const maxSuffixLength = Math.min(text.length, searchedText.length - 1);

  for (let length = maxSuffixLength; length > 0; length--) {
    const suffixStart = text.length - length;

    // Check if text.substring(suffixStart) is a prefix of searchedText.
    // We do this character-by-character to avoid string allocations.
    let match = true;
    for (let j = 0; j < length; j++) {
      if (text[suffixStart + j] !== searchedText[j]) {
        match = false;
        break;
      }
    }

    if (match) {
      return suffixStart;
    }
  }

  return null;
}
