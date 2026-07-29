#!/usr/bin/env python3

import json
from pathlib import Path
import tempfile
import unittest

from render_fresh_campaign_progress import (
    ARMS,
    ace_counts,
    bfcl_counts,
    capture_parity,
    hammer_counts,
    mcpmark_counts,
    stabletoolbench_counts,
    terminalbench_counts,
    terminalbench_label,
    vakra_counts,
    vakra_bridge_root,
)


class FreshCampaignRootSelectionTest(unittest.TestCase):
    def test_progress_uses_native_and_prompt_only_arms(self) -> None:
        # Given/When: the active progress arm declaration is read.
        labels = tuple(label for label, _ in ARMS)

        # Then: no retired Native-Plus arm is present.
        self.assertEqual(labels, ("Native", "Prompt-only"))

    def test_prompt_only_artifacts_contribute_to_progress(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            # Given: one completed artifact for each active prompt-only layout.
            root = Path(directory)
            bfcl = root / "bfcl/official/glm52-prompt-only/category/sample_result.json"
            bfcl.parent.mkdir(parents=True)
            bfcl.write_text("{}\n", encoding="utf-8")
            ace = (
                root
                / "ace/workdir/result_all/result_en/glm52-prompt-only-FC/sample_result.json"
            )
            ace.parent.mkdir(parents=True)
            ace.write_text("{}\n", encoding="utf-8")
            hammer = root / "hammer"
            hammer.mkdir()
            (hammer / "glm52-prompt-only.jsonl").write_text("{}\n", encoding="utf-8")
            stable = root / "stable/outputs/gpt-prompt-only/group"
            stable.mkdir(parents=True)
            (stable / "sample.json").write_text("{}\n", encoding="utf-8")
            terminal = root / "terminal/full-fresh-v1"
            terminal.mkdir(parents=True)
            (terminal / "run-meta.json").write_text(
                json.dumps({"status": "running"}), encoding="utf-8"
            )
            (terminal / "progress.jsonl").write_text(
                json.dumps({"arm": "glm52-prompt-only"}) + "\n",
                encoding="utf-8",
            )

            # When: each progress reader inspects its fresh root.
            prompt_only_counts = (
                bfcl_counts(root / "bfcl")[1],
                ace_counts(root / "ace")[1],
                hammer_counts(hammer)[1],
                stabletoolbench_counts(root / "stable")[1],
                terminalbench_counts(root / "terminal")[1],
            )

            # Then: prompt-only artifacts count in the second arm.
            self.assertEqual(prompt_only_counts, (1, 1, 1, 1, 1))

    def test_stable_progress_reads_canonical_official_arm_group_layout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            # Given: the current StableToolBench official/<arm>/<group> layout.
            root = Path(directory)
            artifact = (
                root
                / "official/gpt-prompt-only/G1_category/sample_CoT@1.json"
            )
            artifact.parent.mkdir(parents=True)
            artifact.write_text("{}\n", encoding="utf-8")

            # When: the shared progress reader inspects the run root.
            counts = stabletoolbench_counts(root)

            # Then: the prompt-only result is counted in the second arm.
            self.assertEqual(counts, (0, 1))

    def test_invalid_mcpmark_root_contributes_no_progress_or_traffic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "run-meta.json").write_text(
                json.dumps({"status": "invalid-provider-failures"}),
                encoding="utf-8",
            )
            bridge = root / "bridge"
            bridge.mkdir()
            (bridge / "requests.jsonl").write_text("{}\n", encoding="utf-8")
            (bridge / "provider-raw.jsonl").write_text("{}\n", encoding="utf-8")
            self.assertEqual(mcpmark_counts(root), (0, 0))
            self.assertEqual(capture_parity(root), (0, 0))

    def test_vakra_bridge_keeps_full_run_name(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "full-fresh-v1"
            output.mkdir()
            (output / "run-meta.json").write_text("{}\n", encoding="utf-8")
            bridge = root / "bridge-full-fresh-v1"
            bridge.mkdir()
            self.assertEqual(vakra_bridge_root(root), bridge)

    def test_terminalbench_label_uses_selected_run_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "full-fresh-v1"
            output.mkdir()
            (output / "run-meta.json").write_text(
                json.dumps({"benchmark": "Terminal-Bench 2.1", "status": "running"}),
                encoding="utf-8",
            )
            self.assertEqual(
                terminalbench_label(root),
                "Terminal-Bench 2.1 · official Harbor population",
            )

    def test_terminalbench_label_retains_identity_after_invalidation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "full-fresh-v1"
            output.mkdir()
            (output / "run-meta.json").write_text(
                json.dumps(
                    {
                        "benchmark": "Terminal-Bench 2.1",
                        "status": "invalid-host-poweroff",
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(
                terminalbench_label(root),
                "Terminal-Bench 2.1 · official Harbor population",
            )

    def test_invalid_bfcl_root_contributes_no_progress(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "run-meta.json").write_text(
                json.dumps({"status": "invalid-host-poweroff"}),
                encoding="utf-8",
            )
            result = root / "official/glm52-native/category/sample_result.json"
            result.parent.mkdir(parents=True)
            result.write_text("{}\n", encoding="utf-8")
            self.assertEqual(bfcl_counts(root), (0, 0))

    def test_vakra_skips_invalid_latest_child(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            valid = root / "full-fresh-v1"
            valid.mkdir()
            (valid / "run-meta.json").write_text(
                json.dumps({"status": "running"}), encoding="utf-8"
            )
            invalid = root / "full-fresh-v2"
            invalid.mkdir()
            (invalid / "run-meta.json").write_text(
                json.dumps({"status": "invalid-host-poweroff"}),
                encoding="utf-8",
            )
            valid_bridge = root / "bridge-full-fresh-v1"
            valid_bridge.mkdir()
            (root / "bridge-full-fresh-v2").mkdir()
            self.assertEqual(vakra_counts(root), (0, 0))
            self.assertEqual(vakra_bridge_root(root), valid_bridge)


if __name__ == "__main__":
    unittest.main()
