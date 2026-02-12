## 2025-05-14 - [getPotentialStartIndex O(N²) Bottleneck]
**Learning:** Naive implementations of `getPotentialStartIndex` that search the entire buffer for potential matches at the end lead to O(N²) complexity in streaming scenarios as the buffer grows. Since a potential match must be a prefix of the searched text, the search loop only needs to check the last `searchedText.length - 1` characters of the buffer.

**Action:** Always limit suffix/prefix matching in streaming buffers to the length of the search target. Additionally, ensure the search finds the *largest* suffix first (earliest start index) to properly handle potential overlapping matches.
