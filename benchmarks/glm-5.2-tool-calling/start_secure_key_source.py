#!/usr/bin/env python3
"""Prompt for the provider key and keep it only in a detached process env."""

from __future__ import annotations

import getpass
import os
from pathlib import Path
import shutil
import subprocess


PROCESS_NAME = "glm52-key-source"


def start_key_source(secret: str) -> int:
    if not secret:
        raise ValueError("provider key must not be empty")
    sleep = shutil.which("sleep")
    if sleep is None:
        raise RuntimeError("sleep executable is unavailable")
    environment = dict(os.environ)
    environment["FREEROUTER_API_KEY"] = secret
    process = subprocess.Popen(
        [PROCESS_NAME, "infinity"],
        executable=sleep,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return process.pid


def process_has_key(pid: int) -> bool:
    environ = Path(f"/proc/{pid}/environ")
    try:
        values = environ.read_bytes().split(b"\0")
    except OSError:
        return False
    prefix = b"FREEROUTER_API_KEY="
    return any(value.startswith(prefix) and len(value) > len(prefix) for value in values)


def main() -> None:
    secret = getpass.getpass("FreeRouter API key (hidden): ")
    pid = start_key_source(secret)
    secret = ""
    if not process_has_key(pid):
        raise RuntimeError("detached key-source process did not retain the key")
    print(f"key-source-ready pid={pid} name={PROCESS_NAME}")


if __name__ == "__main__":
    main()
