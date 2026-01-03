---

"@ai-sdk-tool/parser": patch

---

Fixed prompt normalization in v5 transform handler to handle single message objects, preventing runtime errors when params.prompt is a single ModelMessage instead of an array.