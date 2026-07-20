#!/usr/bin/env python3
"""tau2 CLI wrapper that registers arms and pins the optional NL judge."""

import json
import os

from tau2_native_plus_agent import register_tau2_native_plus_agents
from tau3_openai_compat_agent import register_tau3_openai_compat_agents


def configure_nl_judge_from_env() -> None:
    """Override both copies of tau2's import-time NL judge constants."""

    model = os.environ.get("TAU2_NL_JUDGE_MODEL")
    raw_args = os.environ.get("TAU2_NL_JUDGE_ARGS")
    if model is None and raw_args is None:
        return
    if model is not None and not model.strip():
        raise ValueError("TAU2_NL_JUDGE_MODEL must be a non-empty string")
    args = None
    if raw_args is not None:
        try:
            args = json.loads(raw_args)
        except json.JSONDecodeError as error:
            raise ValueError("TAU2_NL_JUDGE_ARGS must be valid JSON") from error
        if not isinstance(args, dict):
            raise ValueError("TAU2_NL_JUDGE_ARGS must be a JSON object")

    import tau2.config as config
    import tau2.evaluator.evaluator_nl_assertions as nl_evaluator

    if model is not None:
        config.DEFAULT_LLM_NL_ASSERTIONS = model
        nl_evaluator.DEFAULT_LLM_NL_ASSERTIONS = model
    if args is not None:
        config.DEFAULT_LLM_NL_ASSERTIONS_ARGS = args
        nl_evaluator.DEFAULT_LLM_NL_ASSERTIONS_ARGS = args


if __name__ == "__main__":
    register_tau2_native_plus_agents()
    register_tau3_openai_compat_agents()
    configure_nl_judge_from_env()
    from tau2.cli import main

    main()
