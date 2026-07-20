#!/usr/bin/env python3
"""Managed, fail-closed service isolation for StableToolBench inference.

The pinned StableToolBench virtual server reads its configuration from the
current working directory.  This module uses that contract to give every
``group x arm`` lane a separate server process, working directory, and logs.
The large tool and response-cache trees are copied once, content-verified,
and made read-only before any server starts.  Consequently the lane servers
can share those snapshots without sharing mutable benchmark state.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import stat
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, BinaryIO, Iterable


SERVICE_MODE = "managed-per-lane-readonly-snapshot"
TOOLBENCH_UNAVAILABLE_STATUS = 503
PINNED_SIMULATOR_MAX_TOKENS = 1024
SIMULATOR_MAX_TOKENS_MARKER = "max_tokens = 1024,"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def fingerprint_tree(root: Path) -> dict[str, Any]:
    """Return a content-addressed inventory and reject unsafe tree entries."""

    root = root.resolve()
    if not root.is_dir():
        raise RuntimeError(f"StableToolBench snapshot source is not a directory: {root}")
    tree_digest = hashlib.sha256()
    file_count = 0
    directory_count = 1
    total_bytes = 0
    entries = sorted(root.rglob("*"), key=lambda path: path.relative_to(root).as_posix())
    for path in entries:
        relative = path.relative_to(root).as_posix()
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise RuntimeError(
                f"StableToolBench snapshot source contains a symlink: {path}"
            )
        if stat.S_ISDIR(metadata.st_mode):
            directory_count += 1
            tree_digest.update(b"D\0")
            tree_digest.update(relative.encode("utf-8"))
            tree_digest.update(b"\0")
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise RuntimeError(
                f"StableToolBench snapshot source contains a non-regular file: {path}"
            )
        content_digest = sha256_file(path)
        file_count += 1
        total_bytes += metadata.st_size
        tree_digest.update(b"F\0")
        tree_digest.update(relative.encode("utf-8"))
        tree_digest.update(b"\0")
        tree_digest.update(str(metadata.st_size).encode("ascii"))
        tree_digest.update(b"\0")
        tree_digest.update(content_digest.encode("ascii"))
        tree_digest.update(b"\0")
    return {
        "directoryCount": directory_count,
        "fileCount": file_count,
        "sha256": tree_digest.hexdigest(),
        "totalBytes": total_bytes,
    }


def verify_read_only_tree(root: Path) -> None:
    root = root.resolve()
    paths = [root, *root.rglob("*")]
    for path in paths:
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise RuntimeError(f"sealed StableToolBench tree contains a symlink: {path}")
        if metadata.st_mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH):
            raise RuntimeError(f"sealed StableToolBench tree remains writable: {path}")


def seal_tree(root: Path) -> None:
    root = root.resolve()
    entries = sorted(root.rglob("*"), key=lambda path: len(path.parts), reverse=True)
    for path in entries:
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise RuntimeError(f"refusing to seal a symlink: {path}")
        if stat.S_ISDIR(metadata.st_mode):
            path.chmod(0o555)
        elif stat.S_ISREG(metadata.st_mode):
            path.chmod(0o444)
        else:
            raise RuntimeError(f"refusing to seal a non-regular file: {path}")
    root.chmod(0o555)
    verify_read_only_tree(root)


def materialize_read_only_snapshot(source: Path, destination: Path) -> dict[str, Any]:
    """Copy once, prove byte identity, then remove all write permission bits."""

    source = source.resolve()
    destination = destination.absolute()
    if destination.exists():
        raise RuntimeError(f"refusing existing StableToolBench snapshot: {destination}")
    source_before = fingerprint_tree(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination, symlinks=False, copy_function=shutil.copy2)
    copied = fingerprint_tree(destination)
    source_after = fingerprint_tree(source)
    if source_before != source_after:
        raise RuntimeError(
            "StableToolBench snapshot source changed while it was being copied"
        )
    if copied != source_before:
        raise RuntimeError("StableToolBench snapshot copy failed content verification")
    seal_tree(destination)
    sealed = fingerprint_tree(destination)
    if sealed != copied:
        raise RuntimeError("StableToolBench snapshot content changed while being sealed")
    return {
        **sealed,
        "destination": str(destination.resolve()),
        "sealedReadOnly": True,
        "source": str(source),
    }


def verify_reusable_read_only_snapshot(
    source: Path, snapshot: Path
) -> dict[str, Any]:
    """Prove an existing sealed snapshot is byte-identical without copying it."""

    source = source.resolve()
    snapshot = snapshot.resolve()
    source_before = fingerprint_tree(source)
    verify_read_only_tree(snapshot)
    reused = fingerprint_tree(snapshot)
    source_after = fingerprint_tree(source)
    if source_before != source_after:
        raise RuntimeError(
            "StableToolBench snapshot source changed during reuse verification"
        )
    if reused != source_before:
        raise RuntimeError(
            "reusable StableToolBench snapshot does not match the pinned source"
        )
    return {
        **reused,
        "destination": str(snapshot),
        "reused": True,
        "sealedReadOnly": True,
        "source": str(source),
    }


def inspect_server_source(server_root: Path) -> dict[str, Any]:
    server_root = server_root.resolve()
    files: dict[str, str] = {}
    for name in ("main.py", "utils.py"):
        path = server_root / name
        if not path.is_file() or path.is_symlink():
            raise RuntimeError(f"pinned StableToolBench server file is unavailable: {path}")
        files[name] = sha256_file(path)
    return {"files": files, "root": str(server_root)}


def materialize_server_code(
    server_root: Path,
    destination: Path,
    *,
    simulator_max_tokens: int | None = None,
) -> dict[str, Any]:
    source = inspect_server_source(server_root)
    if destination.exists():
        raise RuntimeError(f"refusing existing StableToolBench server snapshot: {destination}")
    if simulator_max_tokens is not None and not 1 <= simulator_max_tokens <= 131_072:
        raise RuntimeError("StableToolBench simulator max tokens is out of range")
    destination.mkdir(parents=True)
    output_files: dict[str, str] = {}
    replacement_count = 0
    for name, expected_digest in source["files"].items():
        source_path = server_root.resolve() / name
        target = destination / name
        if name == "main.py" and simulator_max_tokens is not None:
            source_text = source_path.read_text(encoding="utf-8")
            replacement_count = source_text.count(SIMULATOR_MAX_TOKENS_MARKER)
            if replacement_count != 1:
                raise RuntimeError(
                    "pinned StableToolBench simulator token marker is not unique"
                )
            target.write_text(
                source_text.replace(
                    SIMULATOR_MAX_TOKENS_MARKER,
                    f"max_tokens = {simulator_max_tokens},",
                ),
                encoding="utf-8",
            )
            shutil.copystat(source_path, target)
        else:
            shutil.copy2(source_path, target)
        actual_digest = sha256_file(target)
        if simulator_max_tokens is None and actual_digest != expected_digest:
            raise RuntimeError(f"StableToolBench server snapshot mismatch: {name}")
        output_files[name] = actual_digest
        target.chmod(0o444)
    destination.chmod(0o555)
    verify_read_only_tree(destination)
    return {
        "destination": str(destination.resolve()),
        "files": output_files,
        "sealedReadOnly": True,
        "source": source["root"],
        "sourceFiles": source["files"],
        **(
            {}
            if simulator_max_tokens is None
            else {
                "simulatorMaxTokensTransform": {
                    "replacementCount": replacement_count,
                    "sourceMaxTokens": PINNED_SIMULATOR_MAX_TOKENS,
                    "targetMaxTokens": simulator_max_tokens,
                }
            }
        ),
    }


def verify_reusable_server_code(
    server_root: Path, snapshot: Path
) -> dict[str, Any]:
    """Validate a shared read-only server-code snapshot against pinned source."""

    source = inspect_server_source(server_root)
    snapshot = snapshot.resolve()
    verify_read_only_tree(snapshot)
    actual = inspect_server_source(snapshot)
    if actual["files"] != source["files"]:
        raise RuntimeError(
            "reusable StableToolBench server snapshot does not match pinned source"
        )
    return {
        "destination": str(snapshot),
        "files": actual["files"],
        "reused": True,
        "sealedReadOnly": True,
        "source": source["root"],
    }


@dataclass(frozen=True)
class ServiceLane:
    group: str
    arm: str
    port: int
    workspace: Path

    @property
    def lane_id(self) -> str:
        return f"{self.group}--{self.arm}"

    @property
    def service_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/virtual"

    @property
    def health_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/openapi.json"

    def metadata(self) -> dict[str, Any]:
        return {
            "arm": self.arm,
            "group": self.group,
            "laneId": self.lane_id,
            "port": self.port,
            "serviceUrl": self.service_url,
            "workspace": str(self.workspace.absolute()),
        }


def build_service_lanes(
    *,
    groups: Iterable[str],
    arms: Iterable[str],
    start_port: int,
    isolation_root: Path,
) -> list[ServiceLane]:
    group_values = tuple(groups)
    arm_values = tuple(arms)
    lane_count = len(group_values) * len(arm_values)
    if lane_count == 0:
        raise RuntimeError("StableToolBench managed service plan has no lanes")
    if start_port < 1024 or start_port + lane_count - 1 > 65535:
        raise RuntimeError(
            "StableToolBench managed service port range must stay within 1024..65535"
        )
    lanes: list[ServiceLane] = []
    port = start_port
    for group in group_values:
        for arm in arm_values:
            lanes.append(
                ServiceLane(
                    arm=arm,
                    group=group,
                    port=port,
                    workspace=isolation_root.absolute() / "lanes" / f"{group}--{arm}",
                )
            )
            port += 1
    return lanes


def assert_ports_available(lanes: Iterable[ServiceLane]) -> None:
    reservations: list[socket.socket] = []
    try:
        for lane in lanes:
            reservation = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            reservation.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
            try:
                reservation.bind(("127.0.0.1", lane.port))
            except OSError as error:
                reservation.close()
                raise RuntimeError(
                    f"StableToolBench managed service port is unavailable: {lane.port}"
                ) from error
            reservations.append(reservation)
    finally:
        for reservation in reservations:
            reservation.close()


class _UnavailableToolBenchHandler(BaseHTTPRequestHandler):
    """Return a real HTTP miss so pinned StableToolBench reaches its simulator."""

    protocol_version = "HTTP/1.1"

    def _respond(self) -> None:
        content_length = self.headers.get("Content-Length")
        if content_length:
            try:
                remaining = min(max(int(content_length), 0), 1_048_576)
            except ValueError:
                remaining = 0
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 65_536))
                if not chunk:
                    break
                remaining -= len(chunk)
        body = b'{"error":"real-tool-api-unavailable-use-simulator"}'
        self.send_response(TOOLBENCH_UNAVAILABLE_STATUS)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler contract
        self._respond()

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler contract
        self._respond()

    def log_message(self, _format: str, *_args: object) -> None:
        return


class UnavailableToolBenchStub:
    """Own a stateless loopback HTTP miss endpoint for the pinned server."""

    def __init__(self, port: int) -> None:
        if not 1024 <= port <= 65535:
            raise RuntimeError(
                "StableToolBench unavailable-tool stub port must be within 1024..65535"
            )
        self.port = port
        self.server: ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/unavailable"

    def start(self) -> dict[str, Any]:
        if self.server is not None:
            raise RuntimeError("StableToolBench unavailable-tool stub already started")
        try:
            server = ThreadingHTTPServer(
                ("127.0.0.1", self.port), _UnavailableToolBenchHandler
            )
        except OSError as error:
            raise RuntimeError(
                f"StableToolBench unavailable-tool stub port is unavailable: {self.port}"
            ) from error
        server.daemon_threads = True
        thread = threading.Thread(
            target=server.serve_forever,
            name=f"stabletoolbench-unavailable-tool-{self.port}",
            daemon=True,
        )
        self.server = server
        self.thread = thread
        thread.start()
        try:
            request = urllib.request.Request(self.url, data=b"{}", method="POST")
            urllib.request.urlopen(request, timeout=2)
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
            if status != TOOLBENCH_UNAVAILABLE_STATUS:
                self.stop()
                raise RuntimeError(
                    "StableToolBench unavailable-tool stub returned the wrong status: "
                    f"{status}"
                ) from error
        except BaseException:
            self.stop()
            raise
        return self.metadata()

    def metadata(self) -> dict[str, Any]:
        return {
            "port": self.port,
            "purpose": "force-pinned-server-simulator-fallback-with-http-response",
            "ready": self.server is not None,
            "status": TOOLBENCH_UNAVAILABLE_STATUS,
            "url": self.url,
        }

    def stop(self) -> None:
        server = self.server
        thread = self.thread
        self.server = None
        self.thread = None
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join(timeout=5)


def write_service_config(
    *,
    lane: ServiceLane,
    cache_root: Path,
    tool_root: Path,
    simulator_base_url: str,
    simulator_model: str,
    toolbench_url: str,
) -> dict[str, Any]:
    lane.workspace.mkdir(parents=True, exist_ok=False)
    configuration = {
        "api_base": simulator_base_url,
        "api_key": "benchmark-loopback-only",
        "cache_folder": str(cache_root.resolve()),
        "is_save": False,
        "log_file": str((lane.workspace / "server-events.log").resolve()),
        "model": simulator_model,
        "port": lane.port,
        "temperature": 0,
        "toolbench_url": toolbench_url,
        "tools_folder": str(tool_root.resolve()),
    }
    config_path = lane.workspace / "config.yml"
    config_path.write_text(
        json.dumps(configuration, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    config_digest = sha256_file(config_path)
    config_path.chmod(0o444)
    return {
        "configSha256": config_digest,
        "isSave": False,
        "logPath": configuration["log_file"],
    }


@dataclass
class ServiceRuntime:
    lane: ServiceLane
    process: subprocess.Popen[bytes]
    output: BinaryIO
    config_metadata: dict[str, Any]


class ManagedServiceFarm:
    """Own the lifecycle of one isolated virtual server per inference lane."""

    def __init__(
        self,
        *,
        lanes: list[ServiceLane],
        python: Path,
        server_code_root: Path,
        cache_root: Path,
        tool_root: Path,
        simulator_base_url: str,
        simulator_model: str,
        ready_timeout: float,
        toolbench_stub_port: int,
    ) -> None:
        self.lanes = lanes
        self.python = python.absolute()
        self.server_code_root = server_code_root.resolve()
        self.cache_root = cache_root.resolve()
        self.tool_root = tool_root.resolve()
        self.simulator_base_url = simulator_base_url
        self.simulator_model = simulator_model
        self.ready_timeout = ready_timeout
        self.toolbench_stub = UnavailableToolBenchStub(toolbench_stub_port)
        self.runtimes: list[ServiceRuntime] = []

    def start(self) -> list[dict[str, Any]]:
        if self.runtimes:
            raise RuntimeError("StableToolBench managed service farm already started")
        assert_ports_available(self.lanes)
        main_path = self.server_code_root / "main.py"
        try:
            self.toolbench_stub.start()
            for lane in self.lanes:
                config_metadata = write_service_config(
                    lane=lane,
                    cache_root=self.cache_root,
                    tool_root=self.tool_root,
                    simulator_base_url=self.simulator_base_url,
                    simulator_model=self.simulator_model,
                    toolbench_url=self.toolbench_stub.url,
                )
                output = (lane.workspace / "server-process.log").open("wb")
                environment = dict(os.environ)
                prior_python_path = environment.get("PYTHONPATH")
                environment["PYTHONPATH"] = os.pathsep.join(
                    value
                    for value in (str(self.server_code_root), prior_python_path)
                    if value
                )
                environment["PYTHONUNBUFFERED"] = "1"
                process = subprocess.Popen(
                    [str(self.python), str(main_path)],
                    cwd=lane.workspace,
                    env=environment,
                    stdout=output,
                    stderr=subprocess.STDOUT,
                )
                self.runtimes.append(
                    ServiceRuntime(
                        config_metadata=config_metadata,
                        lane=lane,
                        output=output,
                        process=process,
                    )
                )
            self._wait_until_ready()
        except BaseException:
            self.stop()
            raise
        return [
            {
                **runtime.lane.metadata(),
                **runtime.config_metadata,
                "pid": runtime.process.pid,
                "ready": True,
            }
            for runtime in self.runtimes
        ]

    def _wait_until_ready(self) -> None:
        deadline = time.monotonic() + self.ready_timeout
        pending = {runtime.lane.lane_id: runtime for runtime in self.runtimes}
        while pending:
            for lane_id, runtime in list(pending.items()):
                return_code = runtime.process.poll()
                if return_code is not None:
                    raise RuntimeError(
                        f"StableToolBench service {lane_id} exited before ready: "
                        f"exit {return_code}"
                    )
                try:
                    with urllib.request.urlopen(runtime.lane.health_url, timeout=0.5) as response:
                        document = json.loads(response.read())
                    paths = document.get("paths") if isinstance(document, dict) else None
                    if isinstance(paths, dict) and "/virtual" in paths:
                        pending.pop(lane_id)
                except (
                    OSError,
                    TimeoutError,
                    urllib.error.URLError,
                    json.JSONDecodeError,
                ):
                    pass
            if pending:
                if time.monotonic() >= deadline:
                    identifiers = ", ".join(sorted(pending))
                    raise RuntimeError(
                        "StableToolBench managed services did not become ready: "
                        f"{identifiers}"
                    )
                time.sleep(0.1)

    def stop(self) -> None:
        for runtime in self.runtimes:
            if runtime.process.poll() is None:
                runtime.process.terminate()
        deadline = time.monotonic() + 15
        for runtime in self.runtimes:
            if runtime.process.poll() is not None:
                continue
            timeout = max(0.0, deadline - time.monotonic())
            try:
                runtime.process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                runtime.process.kill()
        for runtime in self.runtimes:
            if runtime.process.poll() is None:
                runtime.process.wait()
            if not runtime.output.closed:
                runtime.output.close()
        self.toolbench_stub.stop()
