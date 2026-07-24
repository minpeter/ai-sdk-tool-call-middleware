#!/usr/bin/env python3

import importlib
import json
from collections.abc import Callable
from typing import cast

parser_event_class = cast(
    Callable[[str, set[str] | None], str],
    importlib.import_module(
        "analyze_agentic_longrunning_parser_health"
    ).parser_event_class,
)


def test_unique_trailing_ids_plural_alias_remains_parser_failure() -> None:
    # Given the exact diagnostic shape and bounded request-local catalog.
    message = "Could not parse GLM-5.2 tool call. " + json.dumps(
        {
            "dropReason": "malformed-glm5-tool-call",
            "toolCall": (
                "<tool_call>get_count_distinct_businesses"
                "<arg_key>active</arg_key><arg_value>false</arg_value>"
                "</tool_call>"
            ),
        }
    )
    declared_tools = {
        "get_count_distinct_business_ids",
        "get_business_count_attributes",
    }

    # When parser health classifies the observed event.
    classification = parser_event_class(message, declared_tools)

    # Then a uniquely recoverable alias is not hidden as model pass-through.
    assert classification == "parse_failure"
