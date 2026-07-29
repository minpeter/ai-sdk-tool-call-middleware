#!/usr/bin/env python3

from __future__ import annotations

from contextlib import redirect_stdout
import importlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch


acebench_one_row_preflight = importlib.import_module("acebench_one_row_preflight")
prepare_acebench_fresh_run = importlib.import_module("prepare_acebench_fresh_run")
validate_acebench_official = importlib.import_module("validate_acebench_official")
validate_bfcl_official = importlib.import_module("validate_bfcl_official")


NATIVE_ALIAS = "glm52-native"
PROMPT_ONLY_ALIAS = "glm52-prompt-only"
ACE_NATIVE_ALIAS = f"{NATIVE_ALIAS}-FC"
ACE_PROMPT_ONLY_ALIAS = f"{PROMPT_ONLY_ALIAS}-FC"
SIMULATOR_ALIAS = "glm52-simulator"


def write_result_ids(path: Path, ids: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(
            json.dumps({"id": task_id, "result": []}) + "\n"
            for task_id in ids
        ),
        encoding="utf-8",
    )


class OfficialValidatorAliasTest(unittest.TestCase):
    def test_bfcl_validator_defaults_to_native_and_prompt_only(self) -> None:
        # Given: complete official result trees under the canonical aliases.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            task_ids = [f"simple_{index}" for index in range(5217)]
            manifest = root / "task-manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "populations": {
                            "all_scoring": [
                                {"id": task_id} for task_id in task_ids
                            ]
                        },
                        "taskSetSha256": "test-only",
                    }
                ),
                encoding="utf-8",
            )
            results = root / "official"
            for alias in (NATIVE_ALIAS, PROMPT_ONLY_ALIAS):
                write_result_ids(
                    results / alias / "BFCL_v4_simple_result.json",
                    task_ids,
                )

            # When: validation runs without an explicit arm override.
            output = io.StringIO()
            with patch.object(
                sys,
                "argv",
                [
                    "validate_bfcl_official.py",
                    "--manifest",
                    str(manifest),
                    "--result-root",
                    str(results),
                ],
            ), redirect_stdout(output):
                validate_bfcl_official.main()

            # Then: the validator consumes the two canonical result trees.
            summary = json.loads(output.getvalue())
            self.assertEqual(
                set(summary["arms"]),
                {NATIVE_ALIAS, PROMPT_ONLY_ALIAS},
            )

    def test_ace_validator_defaults_to_native_and_prompt_only(self) -> None:
        # Given: complete bilingual result trees under the canonical FC aliases.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            language_ids = {
                "en": [f"en_{index}" for index in range(1023)],
                "zh": [f"zh_{index}" for index in range(1017)],
            }
            manifest = root / "task-manifest.json"
            manifest.write_text(
                json.dumps(
                    {
                        "rows": [
                            {
                                "category": "probe",
                                "id": task_id,
                                "language": language,
                            }
                            for language, task_ids in language_ids.items()
                            for task_id in task_ids
                        ],
                        "taskSetSha256": "test-only",
                    }
                ),
                encoding="utf-8",
            )
            results = root / "result_all"
            for alias in (ACE_NATIVE_ALIAS, ACE_PROMPT_ONLY_ALIAS):
                for language, task_ids in language_ids.items():
                    write_result_ids(
                        results
                        / f"result_{language}"
                        / alias
                        / "data_probe_result.json",
                        task_ids,
                    )

            # When: validation runs without an explicit arm override.
            output = io.StringIO()
            with patch.object(
                sys,
                "argv",
                [
                    "validate_acebench_official.py",
                    "--manifest",
                    str(manifest),
                    "--result-root",
                    str(results),
                ],
            ), redirect_stdout(output):
                validate_acebench_official.main()

            # Then: the validator consumes the two canonical result trees.
            summary = json.loads(output.getvalue())
            self.assertEqual(
                set(summary["arms"]),
                {ACE_NATIVE_ALIAS, ACE_PROMPT_ONLY_ALIAS},
            )


class OfficialAcebenchDefaultAliasTest(unittest.TestCase):
    def test_one_row_preflight_defaults_to_prompt_only(self) -> None:
        # Given: a fresh scoreless preflight with provider I/O replaced by fakes.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge_root = root / "bridge"
            bridge_root.mkdir()
            output_path = root / "preflight.json"
            user = MagicMock()
            user.get_init_prompt.return_value = "initial user message"

            # When: the one-row CLI runs without an explicit arm override.
            with patch.object(
                sys,
                "argv",
                [
                    "acebench_one_row_preflight.py",
                    "--manifest",
                    str(root / "task-manifest.json"),
                    "--bridge-root",
                    str(bridge_root),
                    "--output",
                    str(output_path),
                    "--base-url",
                    "http://127.0.0.1:18860/v1",
                ],
            ), patch.object(
                acebench_one_row_preflight,
                "require_pinned_row",
                return_value={
                    "function": [],
                    "involved_classes": [],
                    "question": "probe",
                },
            ), patch.object(
                acebench_one_row_preflight,
                "NativeUser",
                return_value=user,
            ), patch.object(
                acebench_one_row_preflight,
                "NativeAgent",
            ) as agent, patch.object(
                acebench_one_row_preflight,
                "validate_capture",
                return_value={
                    "bridgeRequestRows": 2,
                    "capVerified": 16_384,
                    "linkedCaptureRows": 2,
                    "modelsObserved": [ACE_PROMPT_ONLY_ALIAS, SIMULATOR_ALIAS],
                    "providerCaptureRows": 2,
                    "zeroReuseVerified": True,
                },
            ), redirect_stdout(io.StringIO()):
                acebench_one_row_preflight.main()

            # Then: the assistant request uses the canonical prompt-only alias.
            self.assertEqual(
                agent.call_args.kwargs["model_name"],
                ACE_PROMPT_ONLY_ALIAS,
            )

    def test_prepared_metadata_uses_native_and_prompt_only(self) -> None:
        # Given: a pinned manifest and an attested fresh output root.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output_root = root / "run"
            output_root.mkdir()
            (output_root / "task-manifest.json").write_text(
                json.dumps(
                    {
                        "commit": prepare_acebench_fresh_run.PINNED_COMMIT,
                        "languageCounts": {"en": 1023, "zh": 1017},
                        "rowCount": 2040,
                        "taskSetSha256": (
                            prepare_acebench_fresh_run.PINNED_TASK_SET_SHA256
                        ),
                    }
                ),
                encoding="utf-8",
            )
            (output_root / "runtime-fingerprint.json").write_text(
                json.dumps({"runtimeFingerprint": {}}),
                encoding="utf-8",
            )

            # When: fresh-run metadata is prepared.
            with patch.object(
                sys,
                "argv",
                [
                    "prepare_acebench_fresh_run.py",
                    "--repo-root",
                    str(root),
                    "--output-root",
                    str(output_root),
                    "--implementation-fingerprint",
                    "0" * 64,
                ],
            ), patch.object(
                prepare_acebench_fresh_run,
                "runtime_identity",
                return_value={
                    "runtimeFingerprintAggregateSha256": "1" * 64,
                    "runtimeFingerprintFile": "runtime-fingerprint.json",
                    "runtimeStartAttestation": {"parserSha256": "2" * 64},
                },
            ), redirect_stdout(io.StringIO()):
                prepare_acebench_fresh_run.main()

            # Then: the immutable metadata records the canonical paired arms.
            metadata = json.loads(
                (output_root / "run-meta.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                metadata["arms"],
                [ACE_NATIVE_ALIAS, ACE_PROMPT_ONLY_ALIAS],
            )


if __name__ == "__main__":
    unittest.main()
