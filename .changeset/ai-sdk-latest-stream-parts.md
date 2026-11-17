---
"@ai-sdk-tool/parser": patch
---

Align with the current AI SDK v7 line (`ai@7.0.173`, `@ai-sdk/provider@4.0.38`,
`@ai-sdk/provider-utils@5.0.81`).

- Stream parsers no longer treat the new `ping` heartbeat part (or `raw`
  chunks) as a content boundary. An interleaved `ping` used to flush a
  half-received tool tag as plain text in the morph-xml, yaml-xml, and
  qwen3coder parsers (and `raw` did the same in morph-xml), losing the tool
  call; streaming bare-JSON recovery was interrupted the same way in every
  protocol.
- Preserve the new `interrupted` finish reason for forced tool choice instead
  of rewriting it to `tool-calls`, so the SDK does not execute a tool call
  parsed from an interrupted response.
- Forced tool choice parses the provider-selected `structuredOutputText` when
  a provider reports one, and no longer forwards it after the text has become
  the tool call.
- Carry text `citations` across tool-call parsing in both generate and stream
  results. Offsets are re-anchored only when the surviving range is
  unambiguous. Citations for removed text or an already closed stream block
  are retained without offsets, using an empty text block when necessary.
  Citations already preserved by custom parsers are not duplicated.
  Provider metadata on an unchanged text block is kept in both generate and
  stream results, including metadata supplied at stream start, delta, or end.
- Keep `originalUrl` on URL file parts in tool results when it is another
  spelling of the validated URL without backslashes or tab/newline characters
  that downstream URL parsers can interpret differently.
