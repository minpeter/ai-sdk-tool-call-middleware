from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
from typing import Any
import unittest


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "validate_tau3_full", HERE / "validate_tau3_full.py"
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("validator module could not be loaded")
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)

COUNTS = {
    "airline": 50,
    "retail": 114,
    "telecom": 114,
    "banking_knowledge": 97,
}
COMMIT = "a1e85084a3960281cb06997594133e8f39ea42a7"
STARTED_AT = "2026-07-18T08:00:00+00:00"
RESULT_AT = "2026-07-18T08:01:00+00:00"
PARSER_MTIME = "2026-07-18T07:59:00+00:00"


def canonical_hash(value: object, *, ensure_ascii: bool = False) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=ensure_ascii,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("fixture JSON is not an object")
    return value


class FullFixture:
    def __init__(self, root: Path, prefix: str) -> None:
        self.root = root
        self.repo = root / "repo"
        self.run_root = root / "run"
        self.out = root / "validated.json"
        self.prefix = prefix
        self.repo.mkdir(parents=True)
        self.run_root.mkdir()
        self.tasks_by_domain = self._tasks()
        self.manifest = self._manifest()
        self.manifest_path = self.run_root / "task-manifest.json"
        write_json(self.manifest_path, self.manifest)
        aggregate, parser_sha256 = self._fingerprint()
        self.run_meta = self._run_meta(aggregate, parser_sha256)
        write_json(self.run_root / "run-meta.json", self.run_meta)
        self._results()

    def _tasks(self) -> dict[str, list[dict[str, object]]]:
        return {
            domain: [
                {
                    "id": f"{domain}-{index:03d}",
                    "payload": {"domain": domain, "ordinal": index},
                }
                for index in range(count)
            ]
            for domain, count in COUNTS.items()
        }

    def _manifest(self) -> dict[str, object]:
        rows = [
            {
                "domain": domain,
                "id": str(task["id"]),
                "rowSha256": canonical_hash(task),
            }
            for domain, tasks in self.tasks_by_domain.items()
            for task in tasks
        ]
        stable = {
            "benchmark": "tau3-bench",
            "commit": COMMIT,
            "domainCounts": COUNTS,
            "formatVersion": 1,
            "population": "text-half-duplex-base",
            "taskCount": 375,
            "tasks": rows,
        }
        return {
            **stable,
            "generatedAt": "2026-07-18T07:58:00+00:00",
            "taskSetSha256": canonical_hash(stable),
        }

    def _record(self, relative: str, content: bytes) -> dict[str, object]:
        path = self.repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return {
            "byteLength": len(content),
            "path": relative,
            "sha256": hashlib.sha256(content).hexdigest(),
        }

    def _fingerprint(self) -> tuple[str, str]:
        parser = self._record(
            "src/core/protocols/glm5-call-parsing.ts", b"parser-runtime\n"
        )
        bridge = self._record("bench/bridge.ts", b"bridge-runtime\n")
        runner = self._record("bench/runner.py", b"runner-runtime\n")
        loader = self._record("node_modules/loader.mjs", b"loader-runtime\n")
        material = {
            "files": {
                "bridge": [bridge],
                "parser": [parser],
                "runner": [runner],
            },
            "git": {"head": "1" * 40},
            "loader": loader,
            "node": {
                "byteLength": 4,
                "path": "<external>/node",
                "sha256": hashlib.sha256(b"node").hexdigest(),
                "version": "v24.18.0",
            },
            "schemaVersion": 1,
        }
        aggregate = canonical_hash(material, ensure_ascii=True)
        write_json(
            self.run_root / "runtime-fingerprint.json",
            {"runtimeFingerprint": {**material, "aggregateSha256": aggregate}},
        )
        return aggregate, str(parser["sha256"])

    def _run_meta(self, aggregate: str, parser_sha256: str) -> dict[str, object]:
        return {
            "assistantModel": "zai-org/glm-5.2",
            "benchmarkCommit": COMMIT,
            "bridgeTransientRetryPolicy": {
                "additionalAttempts": 2,
                "delayMs": 5_000,
                "timeoutMsPerAttempt": 180_000,
                "validatorRequiresRecoveredByteIdenticalRequest": True,
            },
            "campaignAdmissionContract": {
                "globalCeiling": 4,
                "tau3": 4,
                "total": 4,
            },
            "completedAt": "2026-07-18T09:00:00+00:00",
            "domainCounts": COUNTS,
            "freshness": {
                "historicalRawInput": False,
                "historicalScoreInput": False,
                "outputRootAbsentBeforeCreation": True,
                "preseed": False,
                "resumeFromPriorRun": False,
                "supersededInvalidRun": "fresh-v7",
            },
            "maxRetries": 0,
            "numTrials": 1,
            "populationPerArm": 375,
            "providerTransientRetries": 2,
            "requestTimeoutSeconds": 960,
            "runtimeFingerprintAggregateSha256": aggregate,
            "runtimeFingerprintFile": "runtime-fingerprint.json",
            "runtimeStartAttestation": {
                "finalParserSourceMtime": PARSER_MTIME,
                "metadataPreparedAfterFinalParserPatch": True,
                "parserSha256": parser_sha256,
            },
            "savePrefix": self.prefix,
            "seed": 52,
            "startedAt": STARTED_AT,
            "status": "inference-complete",
            "taskCountPerArm": 375,
            "taskSetSha256": self.manifest["taskSetSha256"],
            "tau3Concurrency": {
                "armsPerDomain": 2,
                "domainScheduling": "bounded-dynamic-slots",
                "domainWorkers": 2,
                "globalAdmissionCeiling": 4,
                "maxConcurrentChildRuns": 4,
                "maxConcurrentSimulationTasks": 4,
                "taskConcurrencyPerRun": 1,
            },
        }

    def _results_info(self, domain: str, suffix: str) -> dict[str, object]:
        agent = "openai_bridge_native" if suffix == "native" else "openai_bridge_glm5"
        return {
            "agent_info": {
                "implementation": agent,
                "llm": "zai-org/glm-5.2",
                "llm_args": {"timeout_seconds": 960},
            },
            "environment_info": {"domain_name": domain},
            "git_commit": COMMIT,
            "num_trials": 1,
            "retrieval_config": (
                "golden_retrieval" if domain == "banking_knowledge" else None
            ),
            "seed": 52,
            "user_info": {
                "implementation": "user_simulator",
                "llm": "openai/zai-org/glm-5.2",
                "llm_args": {"seed": 52, "temperature": 0},
            },
        }

    def _simulation(
        self, domain: str, suffix: str, task: dict[str, object], index: int
    ) -> dict[str, object]:
        arm = "native" if suffix == "native" else "glm5"
        model = "glm52-native" if suffix == "native" else "glm52-prompt-only"
        return {
            "end_time": RESULT_AT,
            "info": None,
            "messages": [
                {"content": "request", "role": "user"},
                {
                    "raw_data": {"arm": arm, "model": model},
                    "role": "assistant",
                    "tool_calls": [],
                },
            ],
            "reward_info": {"reward": 1},
            "seed": index + 100,
            "start_time": RESULT_AT,
            "task_id": task["id"],
            "termination_reason": "user_stop",
            "timestamp": RESULT_AT,
            "trial": 0,
        }

    def _results(self) -> None:
        simulations_root = self.run_root / "data/simulations"
        simulations_root.mkdir(parents=True)
        for domain, tasks in self.tasks_by_domain.items():
            for suffix in ("native", "glm5"):
                directory = simulations_root / f"{self.prefix}-{domain}-{suffix}"
                directory.mkdir()
                value = {
                    "info": self._results_info(domain, suffix),
                    "simulations": [
                        self._simulation(domain, suffix, task, index)
                        for index, task in enumerate(tasks)
                    ],
                    "tasks": deepcopy(tasks),
                    "timestamp": RESULT_AT,
                }
                write_json(directory / "results.json", value)

    def result_path(self, domain: str, suffix: str) -> Path:
        return (
            self.run_root
            / "data/simulations"
            / f"{self.prefix}-{domain}-{suffix}"
            / "results.json"
        )

    def invoke(self, expected_prefix: str | None = None) -> None:
        VALIDATOR.main(
            [
                "--manifest",
                str(self.manifest_path),
                "--run-root",
                str(self.run_root),
                "--out",
                str(self.out),
                "--expected-save-prefix",
                expected_prefix or self.prefix,
                "--repo-root",
                str(self.repo),
            ]
        )


class ValidateTau3FullTest(unittest.TestCase):
    temporary: tempfile.TemporaryDirectory[str] | None = None
    base = Path()
    fixture_index = 0

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.temporary = temporary
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.fixture_index = 0

    def fixture(self, prefix: str = "fresh-v8") -> FullFixture:
        self.fixture_index += 1
        return FullFixture(self.base / f"fixture-{self.fixture_index}", prefix)

    def assert_fails_closed(
        self,
        fixture: FullFixture,
        *,
        expected_prefix: str | None = None,
        error: type[BaseException] | tuple[type[BaseException], ...] = RuntimeError,
    ) -> None:
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            with self.assertRaises(error):
                fixture.invoke(expected_prefix)
        self.assertFalse(os.path.lexists(fixture.out))

    def test_dynamic_fresh_v8_happy_path(self) -> None:
        fixture = self.fixture()
        with redirect_stdout(io.StringIO()):
            fixture.invoke()
        output = read_json(fixture.out)
        self.assertTrue(output["complete"])
        self.assertEqual(output["savePrefix"], "fresh-v8")
        self.assertEqual(output["taskCountPerArm"], 375)
        self.assertEqual(output["arms"]["glm52-native"]["tasks"], 375)
        self.assertEqual(output["arms"]["glm52-prompt-only"]["tasks"], 375)

    def test_another_safe_prefix_passes(self) -> None:
        fixture = self.fixture("candidate_9.1")
        with redirect_stdout(io.StringIO()):
            fixture.invoke()
        self.assertEqual(read_json(fixture.out)["savePrefix"], "candidate_9.1")

    def test_prefix_mismatch_and_path_traversal_fail_closed(self) -> None:
        mismatch = self.fixture()
        self.assert_fails_closed(mismatch, expected_prefix="fresh-v9")
        traversal = self.fixture()
        self.assert_fails_closed(
            traversal,
            expected_prefix="../fresh-v8",
            error=SystemExit,
        )

    def test_missing_and_extra_output_directories_fail_closed(self) -> None:
        missing = self.fixture()
        shutil.rmtree(missing.result_path("airline", "native").parent)
        self.assert_fails_closed(missing)

        extra = self.fixture()
        (extra.run_root / "data/simulations/unexpected").mkdir()
        self.assert_fails_closed(extra)

    def test_exact_rows_duplicates_and_domain_drift_fail_closed(self) -> None:
        fewer = self.fixture()
        value = read_json(fewer.result_path("airline", "native"))
        value["simulations"].pop()
        write_json(fewer.result_path("airline", "native"), value)
        self.assert_fails_closed(fewer)

        more = self.fixture()
        value = read_json(more.result_path("airline", "native"))
        added = deepcopy(value["simulations"][-1])
        added["task_id"] = "airline-extra"
        value["simulations"].append(added)
        write_json(more.result_path("airline", "native"), value)
        self.assert_fails_closed(more)

        duplicate = self.fixture()
        value = read_json(duplicate.result_path("airline", "native"))
        value["simulations"][1]["task_id"] = value["simulations"][0]["task_id"]
        write_json(duplicate.result_path("airline", "native"), value)
        self.assert_fails_closed(duplicate)

        domain_drift = self.fixture()
        value = read_json(domain_drift.result_path("airline", "native"))
        value["info"]["environment_info"]["domain_name"] = "retail"
        write_json(domain_drift.result_path("airline", "native"), value)
        self.assert_fails_closed(domain_drift)

        manifest_drift = self.fixture()
        manifest = read_json(manifest_drift.manifest_path)
        manifest["domainCounts"]["airline"] = 49
        write_json(manifest_drift.manifest_path, manifest)
        self.assert_fails_closed(manifest_drift)

    def test_run_and_results_timeout_drift_fail_closed(self) -> None:
        for timeout in (959, 961):
            with self.subTest(timeout=timeout):
                fixture = self.fixture()
                run_meta = read_json(fixture.run_root / "run-meta.json")
                run_meta["requestTimeoutSeconds"] = timeout
                write_json(fixture.run_root / "run-meta.json", run_meta)
                self.assert_fails_closed(fixture)

        fixture = self.fixture()
        value = read_json(fixture.result_path("airline", "native"))
        value["info"]["agent_info"]["llm_args"]["timeout_seconds"] = 180
        write_json(fixture.result_path("airline", "native"), value)
        self.assert_fails_closed(fixture)

    def test_retry_window_exceeding_timeout_fails_closed(self) -> None:
        fixture = self.fixture()
        run_meta = read_json(fixture.run_root / "run-meta.json")
        run_meta["bridgeTransientRetryPolicy"]["timeoutMsPerAttempt"] = 190_000
        write_json(fixture.run_root / "run-meta.json", run_meta)
        self.assert_fails_closed(fixture)

    def test_legacy_admission_ceiling_fails_closed(self) -> None:
        fixture = self.fixture()
        run_meta = read_json(fixture.run_root / "run-meta.json")
        run_meta["campaignAdmissionContract"]["globalCeiling"] = 128
        run_meta["campaignAdmissionContract"]["total"] = 128
        run_meta["tau3Concurrency"]["globalAdmissionCeiling"] = 128
        write_json(fixture.run_root / "run-meta.json", run_meta)
        self.assert_fails_closed(fixture)

    def test_noncomplete_statuses_fail_closed(self) -> None:
        for status in ("running", "invalid-incomplete", "invalid-runtime-drift"):
            with self.subTest(status=status):
                fixture = self.fixture()
                run_meta = read_json(fixture.run_root / "run-meta.json")
                run_meta["status"] = status
                write_json(fixture.run_root / "run-meta.json", run_meta)
                self.assert_fails_closed(fixture)

    def test_freshness_flags_fail_closed(self) -> None:
        fields = (
            "preseed",
            "historicalRawInput",
            "historicalScoreInput",
            "resumeFromPriorRun",
        )
        for field in fields:
            with self.subTest(field=field):
                fixture = self.fixture()
                run_meta = read_json(fixture.run_root / "run-meta.json")
                run_meta["freshness"][field] = True
                write_json(fixture.run_root / "run-meta.json", run_meta)
                self.assert_fails_closed(fixture)

    def test_prestart_result_timestamp_fails_closed(self) -> None:
        fixture = self.fixture()
        value = read_json(fixture.result_path("airline", "native"))
        value["simulations"][0]["start_time"] = "2026-07-18T07:59:59+00:00"
        write_json(fixture.result_path("airline", "native"), value)
        self.assert_fails_closed(fixture)

    def test_runtime_fingerprint_and_file_hash_drift_fail_closed(self) -> None:
        aggregate = self.fixture()
        fingerprint = read_json(aggregate.run_root / "runtime-fingerprint.json")
        fingerprint["runtimeFingerprint"]["aggregateSha256"] = "f" * 64
        write_json(aggregate.run_root / "runtime-fingerprint.json", fingerprint)
        self.assert_fails_closed(aggregate)

        file_drift = self.fixture()
        (file_drift.repo / "bench/bridge.ts").write_text("mutated\n", encoding="utf-8")
        self.assert_fails_closed(file_drift)

        attestation = self.fixture()
        run_meta = read_json(attestation.run_root / "run-meta.json")
        run_meta["runtimeStartAttestation"]["parserSha256"] = "e" * 64
        write_json(attestation.run_root / "run-meta.json", run_meta)
        self.assert_fails_closed(attestation)

    def test_task_provenance_drift_fails_closed(self) -> None:
        fixture = self.fixture()
        value = read_json(fixture.result_path("airline", "native"))
        value["tasks"][0]["payload"]["ordinal"] = 999
        write_json(fixture.result_path("airline", "native"), value)
        self.assert_fails_closed(fixture)

    def test_commit_agent_model_seed_and_trial_drift_fail_closed(self) -> None:
        mutations = (
            ("commit", lambda value: value["info"].__setitem__("git_commit", "0" * 40)),
            (
                "agent",
                lambda value: value["info"]["agent_info"].__setitem__(
                    "implementation", "wrong_agent"
                ),
            ),
            (
                "model",
                lambda value: value["info"]["agent_info"].__setitem__(
                    "llm", "wrong/model"
                ),
            ),
            ("seed", lambda value: value["info"].__setitem__("seed", 53)),
            (
                "trial",
                lambda value: value["simulations"][0].__setitem__("trial", 1),
            ),
            (
                "paired-seed",
                lambda value: value["simulations"][0].__setitem__("seed", 999),
            ),
        )
        for label, mutate in mutations:
            with self.subTest(label=label):
                fixture = self.fixture()
                value = read_json(fixture.result_path("airline", "native"))
                mutate(value)
                write_json(fixture.result_path("airline", "native"), value)
                self.assert_fails_closed(fixture)

    def test_infrastructure_and_retained_errors_fail_closed(self) -> None:
        infrastructure = self.fixture()
        value = read_json(infrastructure.result_path("airline", "native"))
        value["simulations"][0]["termination_reason"] = "infrastructure_error"
        write_json(infrastructure.result_path("airline", "native"), value)
        self.assert_fails_closed(infrastructure)

        retained = self.fixture()
        value = read_json(retained.result_path("airline", "native"))
        value["simulations"][0]["info"] = {"error": "provider failure"}
        write_json(retained.result_path("airline", "native"), value)
        self.assert_fails_closed(retained)


if __name__ == "__main__":
    unittest.main()
