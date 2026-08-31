#!/usr/bin/env python3

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from capture_runtime_fingerprint import (
    FingerprintError,
    build_runtime_fingerprint,
    canonical_json_bytes,
    write_json_exclusive,
)


GIT_HEAD = "a" * 40


class RuntimeFingerprintTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "repo"
        self.root.mkdir()
        self.parser_a = self._write("src/parser-a.ts", b"parser-a\n")
        self.parser_b = self._write("src/parser-b.ts", b"parser-b\n")
        self.bridge = self._write("bench/bridge.ts", b"bridge\n")
        self.runner = self._write("bench/runner.py", b"runner\n")
        self.loader = self._write("node_modules/loader.mjs", b"loader\n")
        self.node = self._write(
            "runtime/node",
            b"#!/bin/sh\nprintf 'v24.18.0\\n'\n",
        )
        self.node.chmod(self.node.stat().st_mode | stat.S_IXUSR)

    def _write(self, relative: str, content: bytes) -> Path:
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def _build(self, *, parsers: list[Path] | None = None) -> dict[str, object]:
        with patch(
            "capture_runtime_fingerprint._git_head", return_value=GIT_HEAD
        ):
            return build_runtime_fingerprint(
                repo_root=self.root,
                parser_paths=parsers or [self.parser_a, self.parser_b],
                bridge_paths=[self.bridge],
                runner_paths=[self.runner],
                loader_path=self.loader,
                node_path=self.node,
            )

    def test_builds_deterministic_run_meta_fragment(self) -> None:
        first = self._build(parsers=[self.parser_b, self.parser_a])
        second = self._build(parsers=[self.parser_a, self.parser_b])
        self.assertEqual(first, second)
        self.assertEqual(list(first), ["runtimeFingerprint"])

        fingerprint = first["runtimeFingerprint"]
        self.assertIsInstance(fingerprint, dict)
        assert isinstance(fingerprint, dict)
        self.assertEqual(fingerprint["schemaVersion"], 1)
        self.assertEqual(fingerprint["git"], {"head": GIT_HEAD})
        self.assertEqual(
            [row["path"] for row in fingerprint["files"]["parser"]],
            ["src/parser-a.ts", "src/parser-b.ts"],
        )
        self.assertEqual(fingerprint["loader"]["path"], "node_modules/loader.mjs")
        self.assertEqual(fingerprint["node"]["path"], "<external>/node")
        self.assertEqual(fingerprint["node"]["version"], "v24.18.0")

        material = {
            key: value
            for key, value in fingerprint.items()
            if key != "aggregateSha256"
        }
        expected = hashlib.sha256(canonical_json_bytes(material)).hexdigest()
        self.assertEqual(fingerprint["aggregateSha256"], expected)

    def test_records_bytes_and_hashes_but_never_contents_or_absolute_paths(self) -> None:
        secret = b"FREEROUTER_API_KEY=do-not-serialize"
        self.parser_a.write_bytes(secret)
        value = self._build(parsers=[self.parser_a])
        serialized = json.dumps(value, sort_keys=True)
        record = value["runtimeFingerprint"]["files"]["parser"][0]
        self.assertEqual(record["byteLength"], len(secret))
        self.assertEqual(record["sha256"], hashlib.sha256(secret).hexdigest())
        self.assertNotIn(secret.decode(), serialized)
        self.assertNotIn(str(self.root), serialized)

    def test_rejects_path_outside_repository(self) -> None:
        outside = Path(self.temporary.name) / "outside.ts"
        outside.write_text("outside", encoding="utf-8")
        with self.assertRaisesRegex(FingerprintError, "inside the repository"):
            self._build(parsers=[outside])

    def test_rejects_symlink_escape(self) -> None:
        outside = Path(self.temporary.name) / "outside.ts"
        outside.write_text("outside", encoding="utf-8")
        link = self.root / "src/escape.ts"
        link.symlink_to(outside)
        with self.assertRaisesRegex(FingerprintError, "inside the repository"):
            self._build(parsers=[link])

    def test_rejects_duplicate_runtime_file_across_roles(self) -> None:
        with patch(
            "capture_runtime_fingerprint._git_head", return_value=GIT_HEAD
        ):
            with self.assertRaisesRegex(FingerprintError, "duplicated across roles"):
                build_runtime_fingerprint(
                    repo_root=self.root,
                    parser_paths=[self.parser_a],
                    bridge_paths=[self.parser_a],
                    runner_paths=[self.runner],
                    loader_path=self.loader,
                    node_path=self.node,
                )

    def test_output_is_exclusive_and_mode_is_private(self) -> None:
        output = Path(self.temporary.name) / "fingerprint.json"
        value = {"runtimeFingerprint": {"aggregateSha256": "a" * 64}}
        write_json_exclusive(output, value)
        self.assertEqual(json.loads(output.read_text(encoding="utf-8")), value)
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)

        original = output.read_bytes()
        with self.assertRaisesRegex(FingerprintError, "refusing to overwrite"):
            write_json_exclusive(output, {"replacement": True})
        self.assertEqual(output.read_bytes(), original)

    def test_output_symlink_is_not_followed(self) -> None:
        target = Path(self.temporary.name) / "target.json"
        target.write_text("keep", encoding="utf-8")
        output = Path(self.temporary.name) / "fingerprint.json"
        output.symlink_to(target)
        with self.assertRaises(FingerprintError):
            write_json_exclusive(output, {"replacement": True})
        self.assertEqual(target.read_text(encoding="utf-8"), "keep")

    def test_requires_every_runtime_role(self) -> None:
        with patch(
            "capture_runtime_fingerprint._git_head", return_value=GIT_HEAD
        ):
            with self.assertRaisesRegex(FingerprintError, "parser runtime file"):
                build_runtime_fingerprint(
                    repo_root=self.root,
                    parser_paths=[],
                    bridge_paths=[self.bridge],
                    runner_paths=[self.runner],
                    loader_path=self.loader,
                    node_path=self.node,
                )

    def test_rejects_unexpected_node_version(self) -> None:
        self.node.write_text("#!/bin/sh\nprintf 'secret-value\\n'\n", encoding="utf-8")
        self.node.chmod(self.node.stat().st_mode | stat.S_IXUSR)
        with self.assertRaisesRegex(FingerprintError, "unexpected value"):
            self._build()

    def test_rejects_source_drift_across_capture_window(self) -> None:
        calls = 0

        def head_with_drift(_root: Path) -> str:
            nonlocal calls
            calls += 1
            if calls == 2:
                self.parser_a.write_bytes(b"changed-after-hash\n")
            return GIT_HEAD

        with patch(
            "capture_runtime_fingerprint._git_head", side_effect=head_with_drift
        ):
            with self.assertRaisesRegex(FingerprintError, "file set changed"):
                build_runtime_fingerprint(
                    repo_root=self.root,
                    parser_paths=[self.parser_a],
                    bridge_paths=[self.bridge],
                    runner_paths=[self.runner],
                    loader_path=self.loader,
                    node_path=self.node,
                )

    def test_rejects_git_head_drift(self) -> None:
        with patch(
            "capture_runtime_fingerprint._git_head",
            side_effect=[GIT_HEAD, "b" * 40],
        ):
            with self.assertRaisesRegex(FingerprintError, "git HEAD changed"):
                build_runtime_fingerprint(
                    repo_root=self.root,
                    parser_paths=[self.parser_a],
                    bridge_paths=[self.bridge],
                    runner_paths=[self.runner],
                    loader_path=self.loader,
                    node_path=self.node,
                )


if __name__ == "__main__":
    unittest.main()
