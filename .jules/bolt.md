## 2025-02-13 - [Regex Pre-compilation in Streaming Protocols]
**Learning:** In streaming parsers, creating new `RegExp` objects inside the chunk processing loop (even if the regex pattern is constant for that stream) adds significant overhead and GC pressure. Pre-compiling them once at the start of the stream/call can yield a ~4-10% performance improvement depending on the complexity of the pattern and number of tools.
**Action:** Always pre-compile regexes that depend on dynamic inputs (like tool names) once per call/session instead of inside hot loops.

## 2025-05-15 - [Optimization] getPotentialStartIndex Algorithmic Speedup
**Learning:** O(N) string-scanning utilities in streaming buffers can become O(N^2) hotspots due to repeated scanning of a growing buffer. Limiting the scan range based on the target string length and avoiding allocations (substrings) in the inner loop is crucial. Additionally, finding the longest matching suffix is often more correct than finding the shortest for scanner-like utilities.
**Action:** Always check the loop boundaries of string-scanning utilities to ensure they are constrained by the search target length rather than the input buffer length.
