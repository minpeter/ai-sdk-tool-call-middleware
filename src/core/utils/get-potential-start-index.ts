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

  const textLength = text.length;
  const searchedTextLength = searchedText.length;

  // Performance optimization:
  // 1. Limit the loop to searchedTextLength - 1. Any suffix longer than this
  //    cannot be a prefix of searchedText (and full matches were caught by indexOf).
  //    This prevents O(N²) complexity in growing buffers.
  // 2. Use character-by-character comparison to avoid string allocation overhead
  //    from substring() or startsWith().
  // 3. Find the longest suffix (earliest index) first, which is more correct
  //    for streaming overlapping patterns (e.g., text "ababa", search "ababax").
  const startAt = Math.max(0, textLength - searchedTextLength + 1);

  for (let i = startAt; i < textLength; i++) {
    let match = true;
    const currentSuffixLength = textLength - i;

    for (let j = 0; j < currentSuffixLength; j++) {
      if (text[i + j] !== searchedText[j]) {
        match = false;
        break;
      }
    }

    if (match) {
      return i;
    }
  }

  return null;
}
