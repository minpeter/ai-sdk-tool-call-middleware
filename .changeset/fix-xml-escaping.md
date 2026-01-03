---

"@ai-sdk-tool/parser": patch

---

Fixed XML escaping in formatToolResponseAsXml to prevent invalid XML when tool results contain special characters like < and & in JSON-serialized objects.