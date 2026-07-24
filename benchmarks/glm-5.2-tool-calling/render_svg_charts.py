#!/usr/bin/env python3
"""Render benchmark SVG charts to PNG without forwarding credentials."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any


SECRET_ENVIRONMENT_NAME = re.compile(
    r"(?:api[_-]?key|authorization|credential|password|secret|token)", re.I
)


def sanitized_child_environment() -> dict[str, str]:
    return {
        name: value
        for name, value in os.environ.items()
        if not SECRET_ENVIRONMENT_NAME.search(name)
    }


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def converter_command(svg: Path, png: Path) -> tuple[str, list[str]]:
    rsvg = shutil.which("rsvg-convert")
    if rsvg:
        return (
            "rsvg-convert",
            [
                rsvg,
                "--background-color",
                "white",
                "--output",
                str(png),
                str(svg),
            ],
        )
    magick = shutil.which("magick") or shutil.which("convert")
    if not magick:
        raise RuntimeError(
            "PNG output requires rsvg-convert or ImageMagick (magick/convert)"
        )
    return (
        Path(magick).name,
        [
            magick,
            "-background",
            "white",
            "-density",
            "144",
            str(svg),
            "-strip",
            "-define",
            "png:exclude-chunk=date,time",
            str(png),
        ],
    )


def render(svg: Path) -> dict[str, Any]:
    png = svg.with_suffix(".png")
    converter, command = converter_command(svg, png)
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        env=sanitized_child_environment(),
        text=True,
        timeout=120,
    )
    if completed.returncode != 0 or not png.exists() or png.stat().st_size == 0:
        raise RuntimeError(f"{converter} could not render {svg}")
    return {
        "converter": converter,
        "png": str(png.resolve()),
        "pngBytes": png.stat().st_size,
        "pngSha256": sha256(png),
        "svg": str(svg.resolve()),
        "svgBytes": svg.stat().st_size,
        "svgSha256": sha256(svg),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Render one or more benchmark chart directories to PNG"
    )
    parser.add_argument(
        "--chart-dir",
        action="append",
        dest="chart_dirs",
        required=True,
        type=Path,
    )
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    svg_paths: list[Path] = []
    for chart_dir in args.chart_dirs:
        if not chart_dir.is_dir():
            raise FileNotFoundError(f"Chart directory does not exist: {chart_dir}")
        svg_paths.extend(path for path in chart_dir.rglob("*.svg") if path.is_file())
    svg_paths = sorted(set(svg_paths))
    if not svg_paths:
        raise ValueError("No SVG charts were found")

    rendered = [render(svg) for svg in svg_paths]
    report = {
        "chartDirectories": [str(path.resolve()) for path in args.chart_dirs],
        "charts": rendered,
        "count": len(rendered),
    }
    report_text = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report_text, encoding="utf-8")
    print(report_text, end="")


if __name__ == "__main__":
    main()
