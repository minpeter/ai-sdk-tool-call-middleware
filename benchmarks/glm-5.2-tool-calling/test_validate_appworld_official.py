#!/usr/bin/env python3
"""Focused tests for AppWorld official validation runtime binding."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("validate_appworld_official.py")
SPEC = importlib.util.spec_from_file_location("validate_appworld_official", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
validator = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = validator
SPEC.loader.exec_module(validator)


def wrapped_model_config(base_url: str, arm: str = "glm52-native") -> dict[str, object]:
    return {
        "model_config": {
            "base_url": base_url,
            "max_retries": 100,
            "name": arm,
            "retry_after_n_seconds": 15,
            "use_cache": False,
        }
    }


class AppWorldRuntimeBindingTest(unittest.TestCase):
    def test_bridge_base_url_comes_from_run_metadata(self) -> None:
        self.assertEqual(
            validator.bridge_base_url({"bridgePort": 8863}),
            "http://127.0.0.1:8863/v1",
        )

    def test_bridge_port_must_be_a_real_tcp_port_integer(self) -> None:
        for value in (None, True, 0, -1, 65536, "8863", 8863.0):
            with self.subTest(value=value):
                with self.assertRaisesRegex(RuntimeError, "bridge port is invalid"):
                    validator.bridge_base_url({"bridgePort": value})

    def test_model_config_accepts_the_recorded_bridge(self) -> None:
        base_url = validator.bridge_base_url({"bridgePort": 8863})
        validator.require_model_config(
            wrapped_model_config(base_url),
            "glm52-native",
            base_url,
            Path("config.json"),
        )

    def test_model_config_rejects_a_stale_hardcoded_bridge(self) -> None:
        base_url = validator.bridge_base_url({"bridgePort": 8863})
        with self.assertRaisesRegex(RuntimeError, "model_config.base_url"):
            validator.require_model_config(
                wrapped_model_config("http://127.0.0.1:8806/v1"),
                "glm52-native",
                base_url,
                Path("config.json"),
            )

    def test_runtime_binding_requires_v12_names_and_full_fingerprint(self) -> None:
        run_meta = {
            "campaignAdmissionContract": {
                "appWorld": 8,
                "globalCeiling": 8,
                "total": 8,
            },
            "bridgeTransientRetryPolicy": {
                "additionalAttempts": 2,
                "delayMs": 5_000,
                "timeoutMsPerAttempt": 180_000,
                "validatorRequiresRecoveredByteIdenticalRequest": True,
            },
            "experimentNames": [
                "glm52-native-fresh-v12",
                "glm52-prompt-only-fresh-v12",
            ],
            "experimentTag": "fresh-v12",
            "numProcessesPerExperiment": 2,
            "runtimeFingerprintAggregateSha256": "a" * 64,
            "runtimeFingerprintFile": "runtime-fingerprint.json",
            "runtimeStartAttestation": {"parserSha256": "b" * 64},
            "providerTransientRetries": 2,
        }
        with patch.object(
            validator,
            "validate_runtime_fingerprint",
            return_value={
                "aggregateSha256": "a" * 64,
                "parserFileCount": 122,
                "parserSha256": "b" * 64,
            },
        ):
            validator.require_runtime_binding(Path("run"), run_meta)

        stale = {**run_meta, "experimentNames": ["glm52-native-fresh-v11"]}
        with self.assertRaisesRegex(RuntimeError, "do not match"):
            validator.require_runtime_binding(Path("run"), stale)

        stale_retry = {
            **run_meta,
            "bridgeTransientRetryPolicy": {
                "additionalAttempts": 4,
                "delayMs": 5_000,
                "timeoutMsPerAttempt": 180_000,
                "validatorRequiresRecoveredByteIdenticalRequest": True,
            },
            "providerTransientRetries": 4,
        }
        with self.assertRaisesRegex(RuntimeError, "bridge retry policy"):
            validator.require_runtime_binding(Path("run"), stale_retry)

        stale_contract = {
            **run_meta,
            "campaignAdmissionContract": {
                "appWorld": 8,
                "globalCeiling": 128,
                "total": 128,
            },
        }
        with self.assertRaisesRegex(RuntimeError, "exactly 8/8"):
            validator.require_runtime_binding(Path("run"), stale_contract)


if __name__ == "__main__":
    unittest.main()
