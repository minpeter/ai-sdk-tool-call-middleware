#!/usr/bin/env python3
"""Seal an incomplete fresh run so none of its rows can be reused or scored."""

from __future__ import annotations

import argparse
from datetime import datetime
import json
from pathlib import Path
from typing import Any


def now() -> str:
    return datetime.now().astimezone().isoformat()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".seal.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-meta", type=Path, required=True)
    parser.add_argument("--reason-code", required=True)
    parser.add_argument("--reason", required=True)
    parser.add_argument("--superseded-by", required=True)
    args = parser.parse_args()
    path = args.run_meta.resolve()
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("run metadata must be an object")
    if str(value.get("status", "")).startswith(("scored", "validated")):
        raise RuntimeError("refusing to invalidate a scored or validated run")
    sealed_at = now()
    value.update(
        {
            "completedAt": value.get("completedAt", sealed_at),
            "includedInFinalScore": False,
            "populationContribution": 0,
            "reuseForbidden": True,
            "scoreDisclosure": "forbidden-invalid-fresh-run",
            "status": "invalid-incomplete",
        }
    )
    value["invalidation"] = {
        "reason": args.reason,
        "reasonCode": args.reason_code,
        "sealedAt": sealed_at,
        "supersededBy": args.superseded_by,
    }
    atomic_json(path, value)
    print(
        json.dumps(
            {
                "populationContribution": value["populationContribution"],
                "reuseForbidden": value["reuseForbidden"],
                "status": value["status"],
                "supersededBy": args.superseded_by,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
