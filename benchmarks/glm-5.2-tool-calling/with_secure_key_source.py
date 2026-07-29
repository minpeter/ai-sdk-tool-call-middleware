#!/usr/bin/env python3
"""Exec a command with the provider key inherited from the secure source."""

from __future__ import annotations

import argparse
import os
from pathlib import Path


KEY_NAME = "FREEROUTER_API_KEY"
PROCESS_NAME = b"glm52-key-source"


def detached_key_sources() -> list[tuple[int, str]]:
    prefix = f"{KEY_NAME}=".encode()
    sources: list[tuple[int, str]] = []
    for process in Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            command = (process / "cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        if not command or command[0] != PROCESS_NAME:
            continue
        try:
            values = (process / "environ").read_bytes().split(b"\0")
        except OSError:
            continue
        for value in values:
            if value.startswith(prefix) and len(value) > len(prefix):
                sources.append(
                    (int(process.name), value[len(prefix) :].decode("utf-8"))
                )
                break
    return sources


def provider_key() -> str:
    inherited = os.getenv(KEY_NAME)
    if inherited:
        return inherited
    sources = detached_key_sources()
    if len(sources) != 1:
        raise RuntimeError(
            f"expected exactly one detached key source, found {len(sources)}"
        )
    return sources[0][1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        parser.error("a command is required after --")
    environment = dict(os.environ)
    environment[KEY_NAME] = provider_key()
    os.execvpe(command[0], command, environment)


if __name__ == "__main__":
    main()
