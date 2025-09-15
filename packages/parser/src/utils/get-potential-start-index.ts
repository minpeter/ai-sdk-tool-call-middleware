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
  // a prefix of "searchedText". We go from the end of text inward.
  for (let i = text.length - 1; i >= 0; i--) {
    const suffix = text.substring(i);
    if (searchedText.startsWith(suffix)) {
      return i;
    }
  }

  return null;
}

/**
 * Returns information about potential matches for multiple search texts.
 * Returns the earliest match found, preferring complete matches over partial ones.
 */
export function getPotentialStartIndexMultiple(
  text: string,
  searchedTexts: string[]
): { index: number; matchedText: string; isComplete: boolean } | null {
  if (searchedTexts.length === 0) {
    return null;
  }

  let bestMatch: { index: number; matchedText: string; isComplete: boolean } | null = null;

  // First pass: look for complete matches
  for (const searchedText of searchedTexts) {
    if (searchedText.length === 0) continue;

    const directIndex = text.indexOf(searchedText);
    if (directIndex !== -1) {
      const match = { index: directIndex, matchedText: searchedText, isComplete: true };
      if (!bestMatch || directIndex < bestMatch.index) {
        bestMatch = match;
      }
    }
  }

  // If we found a complete match, return it
  if (bestMatch && bestMatch.isComplete) {
    return bestMatch;
  }

  // Second pass: look for partial matches (suffix of text matching prefix of searchedText)
  for (const searchedText of searchedTexts) {
    if (searchedText.length === 0) continue;

    for (let i = text.length - 1; i >= 0; i--) {
      const suffix = text.substring(i);
      if (searchedText.startsWith(suffix) && suffix.length < searchedText.length) {
        const match = { index: i, matchedText: searchedText, isComplete: false };
        if (!bestMatch || i < bestMatch.index) {
          bestMatch = match;
        }
        break; // We found the longest suffix for this searchedText
      }
    }
  }

  return bestMatch;
}
