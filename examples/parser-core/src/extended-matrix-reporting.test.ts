import { describe, expect, it } from "vitest";
import {
  classifyFailure,
  classifySuccess,
  isRetryableProviderError,
  normalizeStoredResult,
  summarizeResults,
} from "./extended-matrix-reporting";

describe("extended matrix result classification", () => {
  it("keeps output leaks distinct from stream lifecycle failures", () => {
    expect(classifySuccess("len=119 TEXT-LEAK(<tool_call)", [])).toBe(
      "output-leak"
    );
    expect(classifySuccess("calls=2 DELTA-MISMATCH(call-1)", [])).toBe(
      "stream-invariant"
    );
    expect(
      classifyFailure("calls=2 DELTA-MISMATCH(call-1)", ["parser warning"])
    ).toBe("stream-invariant");
  });

  it("classifies observed credit and backend failures as provider errors", () => {
    expect(
      classifyFailure(
        "Credit limit exceeded, please add credits before retrying.",
        []
      )
    ).toBe("provider-error");
    expect(classifyFailure("Backend request failed with status 500", [])).toBe(
      "provider-error"
    );
  });

  it("does not mistake quoted model prose for a harness error", () => {
    expect(
      classifyFailure(
        'no set_alarm call; text="The alarm helper is not a function I can access."',
        []
      )
    ).toBe("expectation-miss");
    expect(
      classifyFailure('content lost markup (&): "<html></html>"', [])
    ).toBe("expectation-miss");
  });

  it("still recognizes actual harness failures", () => {
    expect(classifyFailure("TypeError: value is not iterable", [])).toBe(
      "harness-error"
    );
    expect(classifyFailure("makeRunner is not a function", [])).toBe(
      "harness-error"
    );
  });

  it("reclassifies stored results when resuming", () => {
    expect(
      normalizeStoredResult({
        category: "unclassified",
        detail: "Credit limit exceeded",
        ok: false,
        parserErrors: [],
      })
    ).toMatchObject({ category: "provider-error", ok: false });
  });
});

describe("extended matrix retry and reporting policy", () => {
  it("retries both generic and backend-specific 5xx failures", () => {
    expect(isRetryableProviderError("status code 503")).toBe(true);
    expect(
      isRetryableProviderError("Backend request failed with status 500")
    ).toBe(true);
    expect(
      isRetryableProviderError("Backend request failed with status 400")
    ).toBe(false);
  });

  it("excludes provider failures from quality rates", () => {
    expect(
      summarizeResults([
        { category: "pass" },
        { category: "expectation-miss" },
        { category: "provider-error" },
      ])
    ).toEqual({
      evaluable: 2,
      passRate: 50,
      passed: 1,
      providerUnavailable: 1,
      total: 3,
    });
  });

  it("reports no rate when every result is provider-unavailable", () => {
    expect(summarizeResults([{ category: "provider-error" }])).toMatchObject({
      evaluable: 0,
      passRate: null,
      providerUnavailable: 1,
    });
  });
});
