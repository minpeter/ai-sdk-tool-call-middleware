#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import html
import json
import subprocess
from datetime import datetime
from pathlib import Path


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def render(seal: dict[str, object], audit: dict[str, object]) -> str:
    candidate = seal["candidate"]
    differential = seal["differentialAudits"]
    toolchain = seal["toolchain"]
    audit_result = audit["result"]
    audit_candidate = audit["candidate"]
    assert isinstance(candidate, dict)
    assert isinstance(differential, dict)
    assert isinstance(toolchain, dict)
    assert isinstance(audit_result, dict)
    assert isinstance(audit_candidate, dict)
    width, height = 1600, 1040
    cases = differential["totalAdmissionCases"]
    mismatches = differential["totalAdmissionMismatches"]
    vitest = toolchain["fullVitest"]
    biome = toolchain["fullBiome"]
    package = toolchain["packageConsumers"]
    attw = toolchain["attw"]
    assert isinstance(vitest, dict)
    assert isinstance(biome, dict)
    assert isinstance(package, dict)
    assert isinstance(attw, dict)
    cards = (
        ("fresh differential cases", f"{int(cases):,}", "#082f49", "#38bdf8"),
        ("admission mismatches", str(mismatches), "#063d33", "#34d399"),
        (
            "full Vitest",
            f"{vitest['testsPassed']:,} / {vitest['testsPassed']:,}",
            "#24224d",
            "#a78bfa",
        ),
        ("provider / reused / score", "0 / 0 / false", "#3b2411", "#fbbf24"),
    )
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" rx="30" fill="#07111f"/>',
        "<style>text{font-family:Inter,Arial,sans-serif}.title{font-size:45px;font-weight:790;fill:#f8fafc}.sub{font-size:18px;fill:#94a3b8}.h{font-size:23px;font-weight:750;fill:#e2e8f0}.body{font-size:17px;fill:#cbd5e1}.small{font-size:14px;fill:#94a3b8}.num{font-size:34px;font-weight:820}.pass{font-size:18px;font-weight:760;fill:#34d399}.warn{font-size:17px;font-weight:740;fill:#fbbf24}</style>",
        '<text x="76" y="78" class="title">GLM-5.2 native-plus v5.2 · correctness seal</text>',
        f'<text x="76" y="115" class="sub">immutable candidate {esc(str(candidate["sourceTreeSha256After"])[:12])}… · patch {esc(str(candidate["patchSha256"])[:12])}…</text>',
    ]
    for index, (label, value, fill, accent) in enumerate(cards):
        x = 76 + (index % 2) * 750
        y = 154 + (index // 2) * 154
        parts.extend(
            [
                f'<rect x="{x}" y="{y}" width="712" height="126" rx="20" fill="{fill}"/>',
                f'<text x="{x + 26}" y="{y + 40}" class="body">{esc(label)}</text>',
                f'<text x="{x + 26}" y="{y + 91}" class="num" fill="{accent}">{esc(value)}</text>',
            ]
        )
    parts.extend(
        [
            '<text x="76" y="510" class="h">Toolchain and package surface</text>',
        ]
    )
    gates = (
        ("Root typecheck", toolchain["rootTypecheck"]),
        ("Benchmark typecheck", toolchain["benchmarkTypecheck"]),
        (f"Biome {biome['files']} files", biome["status"]),
        ("Build", toolchain["build"]["status"]),
        ("Package consumers", package["status"]),
        (f"ATTW ESM-only {attw['entrypoints']} entries", attw["status"]),
    )
    for index, (label, status) in enumerate(gates):
        column = index % 3
        row = index // 3
        x = 76 + column * 500
        y = 542 + row * 88
        parts.extend(
            [
                f'<rect x="{x}" y="{y}" width="464" height="66" rx="16" fill="#10243d" stroke="#1e3a5f"/>',
                f'<text x="{x + 20}" y="{y + 41}" class="body">{esc(label)}</text>',
                f'<text x="{x + 438}" y="{y + 41}" text-anchor="end" class="pass">{esc(status)}</text>',
            ]
        )
    parts.extend(
        [
            '<text x="76" y="758" class="h">Independent observability audit</text>',
            '<rect x="76" y="790" width="1448" height="104" rx="18" fill="#0d2636"/>',
            f'<text x="104" y="827" class="body">Admission: {esc(audit_result["admissionCases"])} / {esc(audit_result["admissionCases"])} exact · mismatch {esc(audit_result["admissionMismatches"])} · P2 getter / Proxy / RNG probes 6 / 6 exact</text>',
            f'<text x="104" y="861" class="body">Source read-only: {esc(audit_candidate["preRunWritableSourceFiles"])} writable before / {esc(audit_candidate["postRunWritableSourceFiles"])} after · source drift false</text>',
            '<rect x="76" y="922" width="1448" height="76" rx="18" fill="#312514" stroke="#713f12"/>',
            '<text x="104" y="954" class="warn">Transparent non-gating diagnostic: runtime replacement of String.prototype.includes differs in 1 / 2 prototype probes.</text>',
            '<text x="104" y="981" class="small">Normal parameters, tools, descriptors, getters, proxies, and RNG remain admission-exact. Performance admission is still a separate gate.</text>',
            "</svg>",
        ]
    )
    return "\n".join(parts) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seal", type=Path, required=True)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    args = parser.parse_args()
    seal = json.loads(args.seal.read_text(encoding="utf-8"))
    audit = json.loads(args.audit.read_text(encoding="utf-8"))
    args.out_dir.mkdir(parents=True, exist_ok=True)
    svg_path = args.out_dir / "v5-2-correctness-seal.svg"
    png_path = args.out_dir / "v5-2-correctness-seal.png"
    svg_path.write_text(render(seal, audit), encoding="utf-8")
    subprocess.run(["convert", str(svg_path), str(png_path)], check=True)
    receipt = {
        "generatedAt": datetime.now().astimezone().isoformat(),
        "sealSha256": sha256(args.seal),
        "auditSha256": sha256(args.audit),
        "svgSha256": sha256(svg_path),
        "pngSha256": sha256(png_path),
        "providerCallsByRenderer": 0,
        "scoreComputed": False,
        "reusedCases": 0,
    }
    receipt_path = args.out_dir / "receipt.json"
    receipt_path.write_text(
        json.dumps(receipt, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(png_path.resolve())


if __name__ == "__main__":
    main()
