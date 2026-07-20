#!/usr/bin/env python3

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import tempfile
import unittest
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from . import prepare_agentic_replacement_run as preparer
else:
    import prepare_agentic_replacement_run as preparer


def configured(output_root: Path | None = None) -> preparer.PreparationConfig:
    return preparer.PreparationConfig(
        bridge_port=18866,
        output_root=output_root or Path("/tmp/prompt-only-fresh-root"),
        started_at="2026-07-20T07:00:00+09:00",
        supersedes="",
        hammer_threads=4,
        bfcl_threads=4,
        stable_group_concurrency=1,
        stable_threads=2,
        tau_domain_workers=2,
        tau_request_timeout=960,
        tau_task_concurrency=1,
        save_prefix="prompt-only-20260720",
    )


class AgenticReplacementMetadataTest(unittest.TestCase):
    def test_common_metadata_uses_only_canonical_arms(self) -> None:
        # Given: a new replacement run with a pinned task set.
        config = configured()

        # When: common metadata is constructed.
        metadata = preparer.common(config, {"taskSetSha256": "a" * 64})

        # Then: only the native and prompt-only arms are bound.
        self.assertEqual(
            metadata["arms"], ["glm52-native", "glm52-prompt-only"]
        )

    def test_hammer_metadata_binds_full_denominator_and_cap8(self) -> None:
        # Given: the pinned 61,075-row HammerBench manifest.
        manifest = {
            "codeCommit": "403d58f2d30430b04b16b8f68e69665a7fba1264",
            "datasetRevision": "18b4f4ea47e8b367006391951cf7e69cefa48c73",
            "rowCount": 61075,
            "taskSetSha256": "b" * 64,
        }

        # When: Hammer metadata is constructed at four threads per arm.
        metadata = preparer.hammer_meta(configured(), manifest)

        # Then: exact coverage and the short-suite cap are bound.
        self.assertEqual(metadata["benchmarkId"], "hammerbench")
        self.assertEqual(metadata["populationPerArm"], 61075)
        self.assertEqual(metadata["expectedFreshTrajectories"], 122150)
        self.assertEqual(metadata["totalAdmission"], 8)
        self.assertEqual(metadata["threadsPerArm"], 4)
        self.assertEqual(metadata["maxRetries"], 0)

    def test_bfcl_metadata_excludes_diagnostic_population(self) -> None:
        # Given: the pinned BFCL scoring and diagnostic populations.
        manifest = {
            "commit": "6ea57973c7a6097fd7c5915698c54c17c5b1b6c8",
            "counts": {"all_scoring": 5217, "format_sensitivity": 5200},
            "taskSetSha256": "c" * 64,
        }

        # When: BFCL metadata is constructed at four threads per arm.
        metadata = preparer.bfcl_meta(configured(), manifest)

        # Then: only all_scoring contributes to the fresh denominator.
        self.assertEqual(metadata["benchmarkId"], "bfcl")
        self.assertEqual(metadata["populationPerArm"], 5217)
        self.assertEqual(metadata["diagnosticOnlyCasesPerArm"], 5200)
        self.assertEqual(metadata["expectedFreshTrajectories"], 10434)
        self.assertEqual(metadata["totalAdmission"], 8)
        self.assertEqual(metadata["maxRetries"], 0)

    def test_stable_metadata_uses_agentic_cap4(self) -> None:
        # Given: the pinned StableToolBench manifest.
        manifest = {
            "commit": "aa4ed9f4737ad98bd706663f01d63623c3427812",
            "rowCount": 765,
            "taskSetSha256": "d" * 64,
        }

        # When: Stable metadata is constructed.
        metadata = preparer.stable_meta(configured(), manifest)

        # Then: its aggregate provider admission is four.
        self.assertEqual(metadata["benchmarkId"], "stabletoolbench")
        self.assertEqual(metadata["totalAdmission"], 4)

    def test_tau3_metadata_uses_agentic_cap4(self) -> None:
        # Given: the pinned tau3 manifest.
        manifest = {
            "commit": "a1e85084a3960281cb06997594133e8f39ea42a7",
            "taskCount": 375,
            "taskSetSha256": "e" * 64,
        }

        # When: tau3 metadata is constructed.
        metadata = preparer.tau3_meta(configured(), manifest)

        # Then: both public and detailed admissions are four.
        self.assertEqual(metadata["benchmarkId"], "tau3")
        self.assertEqual(metadata["totalAdmission"], 4)
        self.assertEqual(metadata["tau3Concurrency"]["globalAdmissionCeiling"], 4)

    def test_invalid_suite_admissions_fail_closed(self) -> None:
        # Given: valid manifests paired with invalid aggregate admissions.
        hammer = {
            "codeCommit": preparer.HAMMER_COMMIT,
            "datasetRevision": preparer.HAMMER_DATASET_REVISION,
            "rowCount": 61075,
            "taskSetSha256": "f" * 64,
        }
        stable = {
            "commit": preparer.STABLE_COMMIT,
            "rowCount": 765,
            "taskSetSha256": "1" * 64,
        }
        tau3 = {
            "commit": preparer.TAU3_COMMIT,
            "taskCount": 375,
            "taskSetSha256": "2" * 64,
        }

        # When/Then: every suite rejects a non-canonical allocation.
        with self.assertRaisesRegex(RuntimeError, "eight Hammer"):
            preparer.hammer_meta(
                replace(configured(), hammer_threads=3),
                hammer,
            )
        with self.assertRaisesRegex(RuntimeError, "four Stable"):
            preparer.stable_meta(
                replace(configured(), stable_threads=1),
                stable,
            )
        with self.assertRaisesRegex(RuntimeError, "four tau3"):
            preparer.tau3_meta(
                replace(configured(), tau_task_concurrency=2),
                tau3,
            )

    def test_ledger_binding_uses_authoritative_campaign_and_run_ids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            # Given: metadata and a ledger whose run ID differs from the root name.
            output_root = Path(directory) / "results" / "fresh-stable-root"
            metadata = {
                **preparer.common(configured(output_root), {"taskSetSha256": "3" * 64}),
                "benchmarkId": "stabletoolbench",
                "expectedFreshTrajectories": 1530,
                "populationPerArm": 765,
                "runtimeFingerprintAggregateSha256": "4" * 64,
                "totalAdmission": 4,
            }
            ledger = {
                "formatVersion": 1,
                "campaignId": "campaign-c1",
                "arms": ["glm52-native", "glm52-prompt-only"],
                "freshness": {
                    "captureInputs": [],
                    "historicalResultInputs": [],
                    "preseed": False,
                    "resume": False,
                    "sourceRunRoots": [],
                    "reusedCases": 0,
                },
                "suites": [
                    {
                        "id": "stabletoolbench",
                        "casesPerArm": 765,
                        "freshTrajectories": 1530,
                        "taskSetSha256": "3" * 64,
                        "outputRoot": "results/fresh-stable-root",
                        "runId": "campaign-c1-stabletoolbench",
                    }
                ],
            }

            # When: the metadata and campaign binding are projected.
            bound = preparer.bind_run_to_campaign(metadata, ledger, output_root)
            binding = preparer.campaign_binding(bound)

            # Then: ledger identity wins and every reuse channel is disabled.
            self.assertEqual(bound["campaignId"], "campaign-c1")
            self.assertEqual(bound["runId"], "campaign-c1-stabletoolbench")
            self.assertEqual(binding["suiteId"], "stabletoolbench")
            self.assertEqual(binding["expectedCasesPerArm"], 765)
            self.assertEqual(binding["expectedFreshTrajectories"], 1530)
            self.assertFalse(binding["resume"])
            self.assertFalse(binding["preseed"])
            self.assertEqual(binding["historicalCaptureInputs"], [])
            self.assertEqual(binding["historicalResultInputs"], [])
            self.assertEqual(binding["sourceRunRoots"], [])
            self.assertEqual(binding["reusedCases"], 0)


if __name__ == "__main__":
    unittest.main()
