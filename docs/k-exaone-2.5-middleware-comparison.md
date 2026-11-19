# K-EXAONE 2.5 middleware comparison

This note records a small, reproducible comparison of the text tool-call
presets against LG AI Research's hosted K-EXAONE 2.5 model. It is an
experiment report, not a benchmark: each case was run once, and the model's
format adherence varies between runs.

## Setup

- Model: `k-exaone_v2.5` through `https://api.exaone.ai/v1`
- AI SDK: v7 (`generateText`, `wrapLanguageModel`, `stepCountIs`)
- Presets: `hermesToolMiddleware`, `yamlXmlToolMiddleware`,
  `kExaone2ToolMiddleware`, `qwen3CoderToolMiddleware`,
  `morphXmlToolMiddleware`
- Excluded from the hard matrix: `glm5ToolMiddleware` (the model does not
  follow the GLM-5.2 `<arg_key>/<arg_value>` grammar) and
  `kExaone236BToolMiddleware` (Friendli-only `tool_declare` role; the EXAONE
  API rejects it with HTTP 400)
- Basic matrix: `reasoning_effort: "low"`, `maxOutputTokens: 2048`,
  `stopWhen: stepCountIs(3)`
- Hard matrix: `reasoning_effort: "high"`, `maxOutputTokens: 4096`,
  `stopWhen: stepCountIs(4)`
- One run per case. The API's daily limit was raised to 86,400 requests by
  opting in to usage-data analysis in the EXAONE account settings.

## Basic matrix (5 cases)

| Case | Prompt intent |
|---|---|
| `weather-selection` | Ask for Seoul weather and require `get_weather` |
| `no-tool` | Forbid tools and ask for `17 + 25` |
| `chained` | `find_item` then `get_item_detail` with the returned id |
| `closing-tag` | Pass `alpha</parameter></tool_call>omega` as a string |
| `null-empty-array` | Pass `{"a": null, "b": []}` as an object |

| Middleware | Passed | Rate | Failed cases |
|---|---:|---:|---|
| Hermes | 5/5 | 100% | — |
| YAML/XML | 4/5 | 80% | `closing-tag` |
| K-EXAONE 2.0 | 3/5 | 60% | `closing-tag`, `null-empty-array` |
| Qwen3 Coder | 3/5 | 60% | `closing-tag`, `null-empty-array` |
| Morph XML | 3/5 | 60% | `closing-tag`, `null-empty-array` |
| GLM-5 | 1/5 | 20% | `weather-selection`, `chained`, `closing-tag`, `null-empty-array` |
| K-EXAONE 236B | 0/5 | 0% | HTTP 400 on every case |

## Hard matrix (10 cases)

| Case | Prompt intent |
|---|---|
| `parallel-weather` | Call `get_weather` for Seoul, Tokyo, and Paris in one turn |
| `deep-nested-order` | `create_order` with nested customer, address, items, options, and `total: 0` |
| `special-chars` | Decode a JSON string literal containing newline, tab, quotes, backslashes, `<tag>`, `&`, and an emoji |
| `similar-tools` | Choose `search_user_archive` over `search_users` |
| `error-recovery` | `get_user` returns not-found, then call `create_user` |
| `three-step-chain` | `find_item` → `get_item_detail` → `get_supplier` |
| `large-array` | Pass 20 objects with ids `0..19` |
| `falsy-values` | Preserve `0`, `false`, `""`, `null`, and `[]` |
| `enum-and-optional` | Set enum `high` and omit the optional `location` |
| `nested-arrays` | Pass `[[1,2],[3,4]]` |

| Middleware | Passed | Rate | Failed cases |
|---|---:|---:|---|
| Hermes | 10/10 | 100% | — |
| K-EXAONE 2.0 | 9/10 | 90% | `special-chars` |
| Qwen3 Coder | 9/10 | 90% | `special-chars` |
| Morph XML | 9/10 | 90% | `special-chars` |
| YAML/XML | 8/10 | 80% | `error-recovery`, `three-step-chain` |

## Combined (15 cases)

| Middleware | Passed | Rate |
|---|---:|---:|
| Hermes | 15/15 | 100% |
| YAML/XML | 12/15 | 80% |
| K-EXAONE 2.0 | 12/15 | 80% |
| Qwen3 Coder | 12/15 | 80% |
| Morph XML | 12/15 | 80% |

## Failure analysis

### `closing-tag` and `null-empty-array`

The XML-based presets cannot represent a literal `</parameter>` or
`</tool_call>` inside a value without escaping. When the model emits the
literal tag, the parser sees markup and truncates the value. The same formats
also tend to serialize `{"a": null, "b": []}` as a string because the value
arrives as text, not as a JSON value. Hermes avoids both problems because the
payload is JSON: the closing tag is inside a JSON string, and `null`/`[]`
keep their types.

### `special-chars`

This case is mostly a model-side escape-handling test, not a parser test:

- Hermes decoded the JSON literal correctly and passed the exact string.
- K-EXAONE 2.0 passed the escaped literal
  (`line1\nline2\t\"quoted\" \\backslash\\ ...`) instead of the decoded value.
- Morph XML inserted an extra newline after the tab and kept the escaped
  backslashes.
- Qwen3 Coder spent eight steps reasoning about the escapes and never emitted
  a tool call.

The middleware preserved what the model emitted; the differences come from
how each format and prompt guide the model to decode the literal.

### YAML/XML `error-recovery` and `three-step-chain`

The model produced malformed markup in both cases:

- `error-recovery`: `<tool_call>get_user>` (missing the opening `<` before
  `get_user`).
- `three-step-chain`: the third call was
  `<get_supplier>value?</get_supplier>` with no parameter name or value.

The parser rejected both calls, which is the intended fail-closed behavior.
The failure is format adherence, not a parser regression.

### Over-calling

Hermes passed every case, but it did not always follow "exactly once":

- `falsy-values` called `echo_object` twice.
- `nested-arrays` called `echo_array` three times.

The values were correct in every call. YAML/XML also called the three weather
tools twice in `parallel-weather` (three calls in each of two steps).

## Format lineage

The public K-EXAONE 2.0 chat template
(`LGAI-EXAONE/K-EXAONE-2.0-750B-A37B`) uses the Qwen3-Coder XML grammar:

```jinja
When calling a tool, use XML with <function=...> and one <parameter=...> block per argument.
```

The K-EXAONE 2.5 template is not public at the time of this report. The
results above are consistent with the 2.5 model following Hermes-style JSON
more closely than the 2.0 XML grammar, but a native tool-call capture without
middleware is needed to confirm the exact template.

## Caveats

- Small sample: 5 basic and 10 hard cases, one run each.
- The basic and hard matrices used different `reasoning_effort` values, so the
  combined table is indicative rather than a controlled benchmark.
- `kExaone236BToolMiddleware` is Friendli-specific. Its 0/5 result is an API
  incompatibility (`tool_declare` is rejected by the EXAONE API), not a model
  failure.
- `glm5ToolMiddleware` targets GLM-5.2. Its 1/5 result on K-EXAONE 2.5 is
  expected because the model does not follow the GLM grammar.
- The `special-chars` failures are model-side escape handling. They should not
  be read as parser bugs without a separate parser-level test.
