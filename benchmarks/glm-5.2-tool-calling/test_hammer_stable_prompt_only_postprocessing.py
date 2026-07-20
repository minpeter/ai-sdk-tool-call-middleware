#!/usr/bin/env python3
from __future__ import annotations

import ast
from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parent
HAMMER_SCORER = HERE / "score_hammerbench_full.py"
STABLE_POSTPROCESSORS = (
    HERE / "validate_stabletoolbench_official.py",
    HERE / "stabletoolbench_official_evaluate.py",
    HERE / "score_stabletoolbench_full.py",
)


def assigned_string_tuple(path: Path, name: str) -> tuple[str, ...]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(
            isinstance(target, ast.Name) and target.id == name
            for target in node.targets
        ):
            continue
        if not isinstance(node.value, ast.Tuple):
            raise AssertionError(f"{path.name}: {name} is not a tuple")
        values = tuple(
            element.value
            for element in node.value.elts
            if isinstance(element, ast.Constant)
            and isinstance(element.value, str)
        )
        if len(values) != len(node.value.elts):
            raise AssertionError(f"{path.name}: {name} contains non-string values")
        return values
    raise AssertionError(f"{path.name}: {name} assignment is missing")


def cli_flags(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return {
        str(node.args[0].value)
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "add_argument"
        and node.args
        and isinstance(node.args[0], ast.Constant)
        and isinstance(node.args[0].value, str)
    }


def string_constants(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return {
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    }


class PromptOnlyPostprocessingTest(unittest.TestCase):
    def test_hammer_scorer_uses_canonical_prompt_only_identifier(self) -> None:
        self.assertEqual(
            assigned_string_tuple(HAMMER_SCORER, "ARMS"),
            ("glm52-native", "glm52-prompt-only"),
        )
        self.assertIn("--prompt-only", cli_flags(HAMMER_SCORER))
        self.assertNotIn("--native-plus", cli_flags(HAMMER_SCORER))
        constants = string_constants(HAMMER_SCORER)
        self.assertIn("promptOnlyOnlyPass", constants)
        self.assertNotIn("nativePlusOnlyPass", constants)

    def test_stable_postprocessors_use_canonical_prompt_only_identifier(self) -> None:
        for path in STABLE_POSTPROCESSORS:
            with self.subTest(path=path.name):
                self.assertEqual(
                    assigned_string_tuple(path, "ARMS"),
                    ("gpt-native", "gpt-prompt-only"),
                )
        constants = string_constants(HERE / "score_stabletoolbench_full.py")
        self.assertIn("promptOnlyHigher", constants)
        self.assertNotIn("nativePlusHigher", constants)


if __name__ == "__main__":
    unittest.main()
