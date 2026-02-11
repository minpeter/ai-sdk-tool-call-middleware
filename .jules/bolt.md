## 2025-02-14 - O(N²) Bottleneck in Streaming Buffer Search
**Learning:** The `getPotentialStartIndex` utility, used for finding partial tags in streaming buffers, had an O(N²) complexity because it scanned the entire buffer (which grows as streaming progresses) for every possible suffix. By limiting the search loop to only check suffixes shorter than the target string, the complexity is reduced to O(N + M²), where N is the buffer length and M is the tag length.
**Action:** Always limit suffix-matching loops to the length of the search target when scanning large/growing buffers.
