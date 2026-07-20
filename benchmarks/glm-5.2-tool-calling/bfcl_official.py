#!/usr/bin/env python3
"""Run the pinned BFCL CLI with the two loopback bridge model aliases.

The official repository remains unmodified.  Importing this wrapper registers
two ordinary OpenAI Chat Completions function-calling models, then delegates to
BFCL's own Typer CLI, generation pipeline, executable environments, and scorer.
"""

import os
from urllib.parse import parse_qs, unquote, urlparse

import requests
from bs4 import BeautifulSoup

from bfcl_eval.__main__ import cli
from bfcl_eval.constants.model_config import MODEL_CONFIG_MAPPING, ModelConfig
from bfcl_eval.model_handler.api_inference.openai_completion import (
    OpenAICompletionsHandler,
)
from bfcl_eval.eval_checker.multi_turn_eval.func_source_code.web_search import (
    WebSearchAPI,
)


BRIDGE_RETRY_WINDOW_SECONDS = 920.0
DEFAULT_BFCL_CLIENT_MAX_RETRIES = 6
DEFAULT_BFCL_REQUEST_TIMEOUT_SECONDS = 960.0


def _positive_float_env(name: str, default: float) -> float:
    raw = os.getenv(name, str(default))
    try:
        value = float(raw)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a positive number") from error
    if value <= 0:
        raise RuntimeError(f"{name} must be a positive number")
    return value


def _non_negative_int_env(name: str, default: int) -> int:
    raw = os.getenv(name, str(default))
    try:
        value = int(raw)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a non-negative integer") from error
    if value < 0:
        raise RuntimeError(f"{name} must be a non-negative integer")
    return value


class BridgeOpenAICompletionsHandler(OpenAICompletionsHandler):
    def _build_client_kwargs(self):
        kwargs = super()._build_client_kwargs()
        timeout_seconds = _positive_float_env(
            "BFCL_REQUEST_TIMEOUT_SECONDS",
            DEFAULT_BFCL_REQUEST_TIMEOUT_SECONDS,
        )
        if timeout_seconds <= BRIDGE_RETRY_WINDOW_SECONDS:
            raise RuntimeError(
                "BFCL_REQUEST_TIMEOUT_SECONDS must exceed the 920-second "
                "bridge retry window"
            )
        kwargs["timeout"] = timeout_seconds
        kwargs["max_retries"] = _non_negative_int_env(
            "BFCL_CLIENT_MAX_RETRIES",
            DEFAULT_BFCL_CLIENT_MAX_RETRIES,
        )
        return kwargs


def register_bridge_model(alias: str, display_name: str) -> None:
    MODEL_CONFIG_MAPPING[alias] = ModelConfig(
        model_name=alias,
        display_name=display_name,
        url="https://github.com/minpeter/ai-sdk-tool-call-middleware",
        org="GLM-5.2 parser benchmark",
        license="Benchmark-only",
        model_handler=BridgeOpenAICompletionsHandler,
        input_price=None,
        output_price=None,
        is_fc_model=True,
        # BFCL converts dotted tool names to underscores before an OpenAI call.
        # Its official checker needs this flag to reverse that representation.
        underscore_to_dot=True,
    )


register_bridge_model("glm52-native", "GLM-5.2 Native")
register_bridge_model("glm52-prompt-only", "GLM-5.2 Prompt-Only")


def duckduckgo_html_search(
    self: WebSearchAPI,
    keywords: str,
    max_results: int | None = 10,
    region: str | None = "wt-wt",
) -> list[dict[str, str]] | dict[str, str]:
    """Keyless backend explicitly permitted by BFCL's web-search docs.

    BFCL documents that ``search_engine_query`` may be replaced with another
    search provider.  This keeps the official task logic and fetch tool while
    avoiding an unavailable third-party SerpAPI account.  The selected backend
    is recorded in every run manifest and must not be described as the default
    SerpAPI environment.
    """

    try:
        response = requests.get(
            "https://html.duckduckgo.com/html/",
            params={"q": keywords, "kl": region or "wt-wt"},
            headers={"User-Agent": "Mozilla/5.0 (BFCL reproducibility run)"},
            timeout=20,
        )
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        results: list[dict[str, str]] = []
        for result in soup.select(".result"):
            anchor = result.select_one(".result__a")
            if anchor is None:
                continue
            href = str(anchor.get("href") or "")
            if href.startswith("//"):
                href = f"https:{href}"
            parsed = urlparse(href)
            redirected = parse_qs(parsed.query).get("uddg")
            if redirected:
                href = unquote(redirected[0])
            item = {
                "title": anchor.get_text(" ", strip=True),
                "href": href,
            }
            snippet = result.select_one(".result__snippet")
            if self.show_snippet and snippet is not None:
                item["body"] = snippet.get_text(" ", strip=True)
            results.append(item)
            if len(results) >= (max_results or 10):
                break
        if not results:
            return {"error": "DuckDuckGo HTML returned no search results"}
        return results
    except Exception as error:  # noqa: BLE001 - tool errors are data, not crashes.
        return {"error": f"DuckDuckGo HTML search failed: {error}"}


if os.getenv("BFCL_WEB_SEARCH_BACKEND") == "duckduckgo-html":
    WebSearchAPI.search_engine_query = duckduckgo_html_search


if __name__ == "__main__":
    cli()
