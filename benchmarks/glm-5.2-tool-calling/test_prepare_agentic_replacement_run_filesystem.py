#!/usr/bin/env python3

from __future__ import annotations

from collections.abc import Mapping, Sequence
from contextlib import redirect_stdout
import hashlib
from io import StringIO
import json
from pathlib import Path
import stat
import tempfile
import unittest
from typing import TYPE_CHECKING, TypeAlias


JsonValue: TypeAlias = (
    str | int | float | bool | None | Sequence["JsonValue"] | Mapping[str, "JsonValue"]
)

if TYPE_CHECKING:
    from .capture_runtime_fingerprint import canonical_json_bytes
    from . import prepare_agentic_replacement_run as preparer
else:
    from capture_runtime_fingerprint import canonical_json_bytes
    import prepare_agentic_replacement_run as preparer


class AgenticReplacementFilesystemTest(unittest.TestCase):
    def test_cli_prepares_every_core4_suite_without_provider_calls(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            # Given: four fresh roots bound to real current runner source hashes.
            repo = Path(__file__).resolve().parents[2]
            campaign_root = Path(directory)
            manifests = {
                preparer.Suite.HAMMER: {
                    "codeCommit": preparer.HAMMER_COMMIT,
                    "datasetRevision": preparer.HAMMER_DATASET_REVISION,
                    "rowCount": 61075,
                },
                preparer.Suite.BFCL: {
                    "commit": preparer.BFCL_COMMIT,
                    "counts": {"all_scoring": 5217, "format_sensitivity": 5200},
                },
                preparer.Suite.STABLE: {
                    "commit": preparer.STABLE_COMMIT,
                    "rowCount": 765,
                },
                preparer.Suite.TAU3: {
                    "commit": preparer.TAU3_COMMIT,
                    "taskCount": 375,
                },
            }
            identities = {
                preparer.Suite.HAMMER: ("hammerbench", 61075, 122150),
                preparer.Suite.BFCL: ("bfcl", 5217, 10434),
                preparer.Suite.STABLE: ("stabletoolbench", 765, 1530),
                preparer.Suite.TAU3: ("tau3", 375, 750),
            }

            for index, suite in enumerate(preparer.Suite, start=1):
                with self.subTest(suite=suite):
                    suite_id, cases, trajectories = identities[suite]
                    task_set_sha256 = f"{index:x}" * 64
                    output_root = campaign_root / "results" / f"fresh-{suite.value}"
                    output_root.mkdir(parents=True)
                    manifest = {
                        **manifests[suite],
                        "taskSetSha256": task_set_sha256,
                    }
                    self._write_json(output_root / "task-manifest.json", manifest)
                    self._write_json(
                        output_root / "runtime-fingerprint.json",
                        self._fingerprint(repo, suite),
                    )
                    ledger = {
                        "formatVersion": 1,
                        "campaignId": "campaign-c1",
                        "arms": ["glm52-native", "glm52-prompt-only"],
                        "freshness": {
                            "captureInputs": [],
                            "historicalResultInputs": [],
                            "sourceRunRoots": [],
                            "resume": False,
                            "preseed": False,
                            "reusedCases": 0,
                        },
                        "suites": [{
                            "id": suite_id,
                            "casesPerArm": cases,
                            "freshTrajectories": trajectories,
                            "taskSetSha256": task_set_sha256,
                            "outputRoot": f"results/{output_root.name}",
                            "runId": f"campaign-c1-{suite_id}",
                        }],
                    }
                    ledger_path = campaign_root / f"ledger-{suite.value}.json"
                    self._write_json(ledger_path, ledger)

                    # When: the real CLI boundary prepares the suite.
                    with redirect_stdout(StringIO()):
                        preparer.main([
                            "--repo-root", str(repo),
                            "--suite", suite.value,
                            "--output-root", str(output_root),
                            "--campaign-ledger", str(ledger_path),
                            "--bridge-port", str(18863 + index),
                        ])

                    # Then: both artifacts bind the ledger run ID and denominator.
                    metadata = json.loads(
                        (output_root / "run-meta.json").read_text(encoding="utf-8")
                    )
                    binding = json.loads(
                        (output_root / "campaign-binding.json").read_text(
                            encoding="utf-8"
                        )
                    )
                    self.assertEqual(metadata["runId"], f"campaign-c1-{suite_id}")
                    self.assertEqual(metadata["totalAdmission"], 8 if index < 3 else 4)
                    self.assertEqual(binding["expectedCasesPerArm"], cases)
                    self.assertEqual(binding["expectedFreshTrajectories"], trajectories)

    def test_runtime_identity_requires_exact_suite_runner_closure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            # Given: a fingerprint that replaces Hammer's runner with BFCL's.
            root = Path(directory)
            parser = self._write(root, preparer.PARSER_PATH, b"parser\n")
            unexpected = self._write(
                root,
                Path("benchmarks/glm-5.2-tool-calling/bfcl_official.py"),
                b"runner\n",
            )
            runtime = {
                "aggregateSha256": "0" * 64,
                "schemaVersion": 1,
                "files": {
                    "parser": [self._record(root, parser)],
                    "bridge": [],
                    "runner": [self._record(root, unexpected)],
                },
            }
            fingerprint = {"runtimeFingerprint": runtime}

            # When/Then: preparation rejects the wrong suite closure.
            with self.assertRaisesRegex(RuntimeError, "runner set"):
                preparer.runtime_identity(root, fingerprint, preparer.Suite.HAMMER)

    def test_pair_publication_is_private_and_rolls_back_new_binding(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            # Given: a prepared root whose run-meta completion marker collides.
            root = Path(directory)
            run_meta = root / "run-meta.json"
            run_meta.write_bytes(b"keep-existing\n")
            metadata = {"status": "running"}
            binding = self._binding()

            # When: pair publication reaches the existing completion marker.
            with self.assertRaises(FileExistsError):
                preparer.write_prepared_artifacts(root, metadata, binding)

            # Then: the new binding is rolled back and existing bytes survive.
            self.assertFalse((root / "campaign-binding.json").exists())
            self.assertEqual(run_meta.read_bytes(), b"keep-existing\n")

    def test_pair_publication_writes_binding_before_private_completion_marker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            # Given: an empty prepared root and complete artifact values.
            root = Path(directory)
            metadata = {"status": "running"}
            binding = self._binding()

            # When: the pair is published.
            preparer.write_prepared_artifacts(root, metadata, binding)

            # Then: both artifacts exist with exact content and mode 0600.
            for name, expected in (
                ("campaign-binding.json", binding),
                ("run-meta.json", metadata),
            ):
                path = root / name
                self.assertEqual(json.loads(path.read_text(encoding="utf-8")), expected)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    @staticmethod
    def _write(root: Path, relative: Path, content: bytes) -> Path:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    @staticmethod
    def _record(root: Path, path: Path) -> dict[str, int | str]:
        content = path.read_bytes()
        return {
            "byteLength": len(content),
            "path": path.relative_to(root).as_posix(),
            "sha256": hashlib.sha256(content).hexdigest(),
        }

    @classmethod
    def _fingerprint(
        cls, repo: Path, suite: preparer.Suite
    ) -> dict[str, JsonValue]:
        files = {
            "parser": [cls._record(repo, repo / preparer.PARSER_PATH)],
            "bridge": [
                cls._record(repo, repo / relative)
                for relative in sorted(preparer.EXPECTED_BRIDGE_PATHS)
            ],
            "runner": [
                cls._record(repo, repo / relative)
                for relative in sorted(preparer.EXPECTED_RUNNER_PATHS[suite])
            ],
        }
        material = {
            "files": files,
            "git": {"head": "a" * 40},
            "loader": {"byteLength": 1, "path": "loader.mjs", "sha256": "a" * 64},
            "node": {
                "byteLength": 1,
                "path": "<external>/node",
                "sha256": "b" * 64,
                "version": "v24.18.0",
            },
            "schemaVersion": 1,
        }
        aggregate = hashlib.sha256(canonical_json_bytes(material)).hexdigest()
        return {"runtimeFingerprint": {**material, "aggregateSha256": aggregate}}

    @staticmethod
    def _write_json(path: Path, value: JsonValue) -> None:
        path.write_text(json.dumps(value) + "\n", encoding="utf-8")

    @staticmethod
    def _binding() -> preparer.CampaignBinding:
        material = {"status": "fixture"}
        aggregate = hashlib.sha256(canonical_json_bytes(material)).hexdigest()
        return {
            "formatVersion": 1,
            "campaignId": "campaign-c1",
            "suiteId": "hammerbench",
            "runId": "campaign-c1-hammerbench",
            "arms": ["glm52-native", "glm52-prompt-only"],
            "taskSetSha256": "a" * 64,
            "runtimeFingerprintAggregateSha256": aggregate,
            "expectedCasesPerArm": 61075,
            "expectedFreshTrajectories": 122150,
            "resume": False,
            "preseed": False,
            "historicalCaptureInputs": [],
            "historicalResultInputs": [],
            "sourceRunRoots": [],
            "reusedCases": 0,
        }


if __name__ == "__main__":
    unittest.main()
