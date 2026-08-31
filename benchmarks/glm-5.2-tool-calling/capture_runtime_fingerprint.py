#!/usr/bin/env python3
"""Capture an immutable, secret-free fingerprint of a benchmark runtime.

The helper reads only explicitly selected runtime files.  It never records file
contents, environment variables, command lines, or absolute repository paths.
Its sole write is an exclusively-created JSON output suitable for merging into
a run-meta object.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from typing import Iterable


SCHEMA_VERSION = 1
RUNTIME_ROLES = ("parser", "bridge", "runner")
GIT_HEAD_RE = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
NODE_VERSION_RE = re.compile(
    r"v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?\Z"
)
CONTROL_CHARACTER_RE = re.compile(r"[\x00-\x1f\x7f]")
READ_CHUNK_BYTES = 1024 * 1024


class FingerprintError(RuntimeError):
    """Raised when a fingerprint cannot be captured without ambiguity."""


def canonical_json_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _safe_subprocess_environment() -> dict[str, str]:
    return {"LANG": "C", "LC_ALL": "C"}


def _run_text(command: list[str], *, cwd: Path | None = None) -> str:
    try:
        result = subprocess.run(
            command,
            check=True,
            cwd=cwd,
            env=_safe_subprocess_environment(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise FingerprintError(
            f"runtime identity command failed: {command[0]}"
        ) from error
    return result.stdout.strip()


def _git_head(repo_root: Path) -> str:
    git = shutil.which("git")
    if git is None:
        raise FingerprintError("git executable is unavailable")
    head = _run_text(
        [git, "-C", str(repo_root), "rev-parse", "--verify", "HEAD"]
    ).lower()
    if not GIT_HEAD_RE.fullmatch(head):
        raise FingerprintError("git HEAD is not a full hexadecimal object id")
    return head


def _assert_safe_relative_path(path: Path) -> str:
    value = path.as_posix()
    if (
        not value
        or value == "."
        or value.startswith("../")
        or CONTROL_CHARACTER_RE.search(value)
    ):
        raise FingerprintError("runtime path is not a safe repository-relative path")
    return value


def _repo_file(
    repo_root: Path, value: str | Path, *, label: str
) -> tuple[Path, str]:
    requested = Path(value)
    candidate = requested if requested.is_absolute() else repo_root / requested
    try:
        resolved = candidate.resolve(strict=True)
        relative = resolved.relative_to(repo_root)
    except (OSError, ValueError) as error:
        raise FingerprintError(f"{label} must resolve inside the repository") from error
    if not resolved.is_file():
        raise FingerprintError(f"{label} must be a regular file")
    return resolved, _assert_safe_relative_path(relative)


def _stat_identity(stats: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        stats.st_dev,
        stats.st_ino,
        stats.st_size,
        stats.st_mtime_ns,
        stats.st_ctime_ns,
    )


def _hash_stable_file(
    path: Path,
) -> tuple[int, str, tuple[int, int, int, int, int]]:
    digest = hashlib.sha256()
    byte_length = 0
    try:
        with path.open("rb") as handle:
            before = os.fstat(handle.fileno())
            while chunk := handle.read(READ_CHUNK_BYTES):
                byte_length += len(chunk)
                digest.update(chunk)
            after = os.fstat(handle.fileno())
        final = path.stat()
    except OSError as error:
        raise FingerprintError("runtime file could not be read") from error
    if (
        _stat_identity(before) != _stat_identity(after)
        or _stat_identity(after) != _stat_identity(final)
        or byte_length != after.st_size
    ):
        raise FingerprintError("runtime file changed while it was being fingerprinted")
    return byte_length, digest.hexdigest(), _stat_identity(after)


def _repo_file_record(
    repo_root: Path, value: str | Path, *, label: str
) -> tuple[Path, dict[str, object], tuple[int, int, int, int, int]]:
    resolved, relative = _repo_file(repo_root, value, label=label)
    byte_length, sha256, identity = _hash_stable_file(resolved)
    return (
        resolved,
        {
            "byteLength": byte_length,
            "path": relative,
            "sha256": sha256,
        },
        identity,
    )


def _node_record(
    value: str | Path | None,
) -> tuple[Path, dict[str, object], tuple[int, int, int, int, int]]:
    if value is None:
        selected = shutil.which("node")
    else:
        requested_value = str(value)
        selected = (
            shutil.which(requested_value)
            if Path(requested_value).name == requested_value
            else requested_value
        )
    if not selected:
        raise FingerprintError("node executable is unavailable")
    requested = Path(selected)
    try:
        resolved = requested.resolve(strict=True)
    except OSError as error:
        raise FingerprintError("node executable could not be resolved") from error
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise FingerprintError("node executable must be an executable regular file")

    identity_before = _stat_identity(resolved.stat())
    version = _run_text([str(resolved), "--version"])
    if not NODE_VERSION_RE.fullmatch(version):
        raise FingerprintError("node --version returned an unexpected value")
    byte_length, sha256, identity = _hash_stable_file(resolved)
    if identity_before != _stat_identity(resolved.stat()):
        raise FingerprintError("node executable changed while it was being fingerprinted")
    return (
        resolved,
        {
            "byteLength": byte_length,
            # Absolute host paths can disclose usernames or installation layout.
            "path": f"<external>/{resolved.name}",
            "sha256": sha256,
            "version": version,
        },
        identity,
    )


def _role_records(
    repo_root: Path,
    role: str,
    values: Iterable[str | Path],
) -> tuple[
    list[Path],
    list[dict[str, object]],
    dict[Path, tuple[int, int, int, int, int]],
]:
    resolved_paths: list[Path] = []
    records: list[dict[str, object]] = []
    identities: dict[Path, tuple[int, int, int, int, int]] = {}
    for value in values:
        resolved, record, identity = _repo_file_record(
            repo_root, value, label=f"{role} runtime file"
        )
        resolved_paths.append(resolved)
        records.append(record)
        identities[resolved] = identity
    if not records:
        raise FingerprintError(f"at least one {role} runtime file is required")
    records.sort(key=lambda record: str(record["path"]))
    return resolved_paths, records, identities


def _assert_capture_set_unchanged(
    identities: dict[Path, tuple[int, int, int, int, int]],
) -> None:
    for path, expected in identities.items():
        try:
            actual = _stat_identity(path.stat())
        except OSError as error:
            raise FingerprintError(
                "runtime file disappeared during fingerprint capture"
            ) from error
        if actual != expected:
            raise FingerprintError(
                "runtime file set changed during fingerprint capture"
            )


def build_runtime_fingerprint(
    *,
    repo_root: str | Path,
    parser_paths: Iterable[str | Path],
    bridge_paths: Iterable[str | Path],
    runner_paths: Iterable[str | Path],
    loader_path: str | Path,
    node_path: str | Path | None = None,
) -> dict[str, object]:
    """Build a deterministic object that can be merged directly into run-meta."""

    try:
        root = Path(repo_root).resolve(strict=True)
    except OSError as error:
        raise FingerprintError("repository root could not be resolved") from error
    if not root.is_dir():
        raise FingerprintError("repository root must be a directory")
    git_head = _git_head(root)

    role_values = {
        "parser": parser_paths,
        "bridge": bridge_paths,
        "runner": runner_paths,
    }
    role_paths: dict[str, list[Path]] = {}
    files: dict[str, list[dict[str, object]]] = {}
    identities: dict[Path, tuple[int, int, int, int, int]] = {}
    for role in RUNTIME_ROLES:
        role_paths[role], files[role], role_identities = _role_records(
            root, role, role_values[role]
        )
        identities.update(role_identities)

    # Re-read every selected file's identity after the full capture so the
    # output cannot combine bytes from source states that never coexisted.
    loader_resolved, loader, loader_identity = _repo_file_record(
        root, loader_path, label="Node loader"
    )
    identities[loader_resolved] = loader_identity
    node_resolved, node, node_identity = _node_record(node_path)
    identities[node_resolved] = node_identity

    selected_paths = [
        path for paths in role_paths.values() for path in paths
    ] + [loader_resolved, node_resolved]
    if len(selected_paths) != len(set(selected_paths)):
        raise FingerprintError("runtime files must not be duplicated across roles")
    if _git_head(root) != git_head:
        raise FingerprintError("git HEAD changed during fingerprint capture")
    _assert_capture_set_unchanged(identities)

    material: dict[str, object] = {
        "files": files,
        "git": {"head": git_head},
        "loader": loader,
        "node": node,
        "schemaVersion": SCHEMA_VERSION,
    }
    aggregate = hashlib.sha256(canonical_json_bytes(material)).hexdigest()
    return {
        "runtimeFingerprint": {
            **material,
            "aggregateSha256": aggregate,
        }
    }


def write_json_exclusive(path: str | Path, value: object) -> None:
    """Write one JSON file without ever replacing an existing filesystem entry."""

    output = Path(path)
    if not output.parent.is_dir():
        raise FingerprintError("output parent directory does not exist")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(output, flags, 0o600)
    except FileExistsError as error:
        raise FingerprintError(
            "refusing to overwrite existing fingerprint output"
        ) from error
    except OSError as error:
        raise FingerprintError("fingerprint output could not be created") from error

    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=True, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        try:
            output.unlink(missing_ok=True)
        finally:
            raise


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Capture a deterministic, sanitized benchmark runtime fingerprint."
    )
    default_root = Path(__file__).resolve().parents[2]
    parser.add_argument("--repo-root", type=Path, default=default_root)
    parser.add_argument("--parser", action="append", required=True, dest="parsers")
    parser.add_argument("--bridge", action="append", required=True, dest="bridges")
    parser.add_argument("--runner", action="append", required=True, dest="runners")
    parser.add_argument("--loader", required=True)
    parser.add_argument("--node")
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    fingerprint = build_runtime_fingerprint(
        repo_root=args.repo_root,
        parser_paths=args.parsers,
        bridge_paths=args.bridges,
        runner_paths=args.runners,
        loader_path=args.loader,
        node_path=args.node,
    )
    write_json_exclusive(args.output, fingerprint)
    print(
        json.dumps(
            {
                "aggregateSha256": fingerprint["runtimeFingerprint"][
                    "aggregateSha256"
                ],
                "status": "captured",
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except FingerprintError as error:
        raise SystemExit(f"runtime fingerprint failed: {error}") from error
