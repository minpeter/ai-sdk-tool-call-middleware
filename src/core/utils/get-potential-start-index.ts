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
  //
  // Optimization: We only need to check suffixes of "text" that are shorter
  // than "searchedText". If a suffix was longer than or equal to "searchedText",
  // it would have been found by the indexOf check above (if it matched
  // searchedText) or it can't be a prefix of searchedText (if it's longer).
  // This reduces complexity from O(N^2) to O(N + M^2) where N is text length
  // and M is searchedText length.
  const minIndex = Math.max(0, text.length - searchedText.length + 1);

  for (let i = text.length - 1; i >= minIndex; i -= 1) {
    const suffix = text.substring(i);
    if (searchedText.startsWith(suffix)) {
      return i;
    }
  }

  return null;
}
