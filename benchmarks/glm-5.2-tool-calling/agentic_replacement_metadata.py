from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum, unique
from pathlib import Path
import re
from typing import Any, Final, Mapping, TypedDict


HAMMER_COMMIT: Final = "403d58f2d30430b04b16b8f68e69665a7fba1264"
HAMMER_DATASET_REVISION: Final = "18b4f4ea47e8b367006391951cf7e69cefa48c73"
BFCL_COMMIT: Final = "6ea57973c7a6097fd7c5915698c54c17c5b1b6c8"
STABLE_COMMIT: Final = "aa4ed9f4737ad98bd706663f01d63623c3427812"
TAU3_COMMIT: Final = "a1e85084a3960281cb06997594133e8f39ea42a7"
CANONICAL_ARMS: Final = ("glm52-native", "glm52-prompt-only")
SHA256_RE: Final = re.compile(r"[0-9a-f]{64}\Z")


@unique
class Suite(StrEnum):
    HAMMER = "hammer"
    BFCL = "bfcl"
    STABLE = "stable"
    TAU3 = "tau3"


@dataclass(frozen=True, slots=True)
class PreparationConfig:
    bridge_port: int
    output_root: Path
    started_at: str
    supersedes: str
    hammer_threads: int = 4
    bfcl_threads: int = 4
    stable_group_concurrency: int = 1
    stable_threads: int = 2
    tau_domain_workers: int = 2
    tau_request_timeout: int = 960
    tau_task_concurrency: int = 1
    save_prefix: str = "prompt-only-20260720"


class CampaignBinding(TypedDict):
    formatVersion: int
    campaignId: str
    suiteId: str
    runId: str
    arms: list[str]
    taskSetSha256: str
    runtimeFingerprintAggregateSha256: str
    expectedCasesPerArm: int
    expectedFreshTrajectories: int
    resume: bool
    preseed: bool
    historicalCaptureInputs: list[str]
    historicalResultInputs: list[str]
    sourceRunRoots: list[str]
    reusedCases: int


class PreparationError(RuntimeError):
    message: str

    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)


def _task_set_sha256(manifest: Mapping[str, Any]) -> str:
    value = manifest.get("taskSetSha256")
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        raise PreparationError("manifest taskSetSha256 is invalid")
    return value


def common(config: PreparationConfig, manifest: Mapping[str, Any]) -> dict[str, Any]:
    provisional_run_id = config.output_root.name
    return {
        "arms": list(CANONICAL_ARMS),
        "bridgePort": config.bridge_port,
        "bridgeSuite": provisional_run_id,
        "bridgeTransientRetryPolicy": {
            "additionalAttempts": 2,
            "delayMs": 5000,
            "timeoutMsPerAttempt": 180000,
            "validatorRequiresRecoveredByteIdenticalRequest": True,
        },
        "freshness": {
            "historicalRawInput": False,
            "historicalScoreInput": False,
            "outputRootAbsentBeforeCreation": True,
            "preseed": False,
            "resumeFromPriorRun": False,
            "supersededInvalidRun": config.supersedes,
        },
        "includedInFinalScore": False,
        "populationContribution": 0,
        "providerTransientRetries": 2,
        "runId": provisional_run_id,
        "scoreDisclosure": "locked-until-exact-denominator-and-official-validator",
        "startedAt": config.started_at,
        "status": "running",
        "taskSetSha256": _task_set_sha256(manifest),
        "transport": "generate via captured loopback OpenAI bridge",
    }


def hammer_meta(config: PreparationConfig, manifest: Mapping[str, Any]) -> dict[str, Any]:
    if (
        manifest.get("codeCommit") != HAMMER_COMMIT
        or manifest.get("datasetRevision") != HAMMER_DATASET_REVISION
        or manifest.get("rowCount") != 61075
    ):
        raise PreparationError("HammerBench manifest is not the pinned population")
    admission = 2 * config.hammer_threads
    if admission != 8:
        raise PreparationError("replacement campaign allocates exactly eight Hammer admissions")
    return {
        **common(config, manifest),
        "benchmark": "HammerBench EN+ZH full population",
        "benchmarkCommit": HAMMER_COMMIT, "benchmarkId": "hammerbench",
        "campaignAdmissionContract": {"globalCeiling": 8, "hammerBench": 8, "total": 8},
        "datasetRevision": HAMMER_DATASET_REVISION,
        "expectedFreshTrajectories": 122150, "populationPerArm": 61075,
        "maxRetries": 0,
        "threadsPerArm": config.hammer_threads, "totalAdmission": admission,
    }


def bfcl_meta(config: PreparationConfig, manifest: Mapping[str, Any]) -> dict[str, Any]:
    expected_counts = {"all_scoring": 5217, "format_sensitivity": 5200}
    if manifest.get("commit") != BFCL_COMMIT or manifest.get("counts") != expected_counts:
        raise PreparationError("BFCL manifest is not the pinned population")
    admission = 2 * config.bfcl_threads
    if admission != 8:
        raise PreparationError("replacement campaign allocates exactly eight BFCL admissions")
    return {
        **common(config, manifest),
        "benchmark": "BFCL V4 all_scoring",
        "benchmarkCommit": BFCL_COMMIT, "benchmarkId": "bfcl",
        "campaignAdmissionContract": {"bfcl": 8, "globalCeiling": 8, "total": 8},
        "diagnosticOnlyCasesPerArm": 5200,
        "diagnosticOnlyPopulation": "format_sensitivity",
        "expectedFreshTrajectories": 10434, "populationPerArm": 5217,
        "maxRetries": 0,
        "testCategory": "all_scoring",
        "threadsPerArm": config.bfcl_threads, "totalAdmission": admission,
    }


def stable_meta(config: PreparationConfig, manifest: Mapping[str, Any]) -> dict[str, Any]:
    if manifest.get("commit") != STABLE_COMMIT or manifest.get("rowCount") != 765:
        raise PreparationError("StableToolBench manifest is not the pinned population")
    admission = 2 * config.stable_group_concurrency * config.stable_threads
    if admission != 4:
        raise PreparationError("replacement campaign allocates exactly four Stable admissions")
    return {
        **common(config, manifest),
        "benchmark": "StableToolBench six canonical solvable-query groups",
        "benchmarkCommit": STABLE_COMMIT, "benchmarkId": "stabletoolbench",
        "campaignAdmissionContract": {
            "globalCeiling": 4, "stableToolBench": 4, "total": 4
        },
        "expectedFreshTrajectories": 1530, "populationPerArm": 765,
        "groupConcurrency": config.stable_group_concurrency,
        "groupCounts": manifest.get("groupCounts"),
        "judgeEvaluationsPerQuery": 3, "method": "CoT@1",
        "maxRetries": 0,
        "serviceIsolationMode": "managed-per-lane-readonly-snapshot",
        "threadsPerArm": config.stable_threads, "totalAdmission": admission,
        "toolbenchUnavailableStub": {
            "expectedStatus": 503,
            "purpose": "reach-pinned-simulator-fallback-without-source-patch",
        },
    }


def tau3_meta(config: PreparationConfig, manifest: Mapping[str, Any]) -> dict[str, Any]:
    if manifest.get("commit") != TAU3_COMMIT or manifest.get("taskCount") != 375:
        raise PreparationError("tau3 manifest is not the pinned population")
    admission = 2 * config.tau_domain_workers * config.tau_task_concurrency
    if admission != 4:
        raise PreparationError("replacement campaign allocates exactly four tau3 admissions")
    return {
        **common(config, manifest),
        "agentAdapter": "tau3_openai_compat_agent.py",
        "assistantModel": "zai-org/glm-5.2",
        "benchmark": "tau3-bench text half-duplex",
        "benchmarkCommit": TAU3_COMMIT, "benchmarkId": "tau3",
        "campaignAdmissionContract": {"globalCeiling": 4, "tau3": 4, "total": 4},
        "domainCounts": manifest.get("domainCounts"),
        "expectedFreshTrajectories": 750, "populationPerArm": 375,
        "maxRetries": 0,
        "numTrials": 1, "seed": 52, "temperature": 0,
        "requestTimeoutSeconds": config.tau_request_timeout,
        "savePrefix": config.save_prefix,
        "taskCountPerArm": 375, "totalAdmission": admission,
        "tau3Concurrency": {
            "armsPerDomain": 2,
            "domainScheduling": "bounded-dynamic-slots",
            "domainWorkers": config.tau_domain_workers,
            "globalAdmissionCeiling": 4,
            "maxConcurrentChildRuns": 2 * config.tau_domain_workers,
            "maxConcurrentSimulationTasks": admission,
            "taskConcurrencyPerRun": config.tau_task_concurrency,
        },
    }


def bind_run_to_campaign(
    metadata: Mapping[str, Any],
    ledger: Mapping[str, Any],
    output_root: Path,
) -> dict[str, Any]:
    if ledger.get("formatVersion") != 1 or ledger.get("arms") != list(CANONICAL_ARMS):
        raise PreparationError("campaign ledger identity is invalid")
    campaign_id = ledger.get("campaignId")
    suite_id = metadata.get("benchmarkId")
    suites = ledger.get("suites")
    if not isinstance(campaign_id, str) or not isinstance(suite_id, str):
        raise PreparationError("campaign or suite identity is missing")
    if not isinstance(suites, list):
        raise PreparationError("campaign suite inventory is missing")
    matches = [suite for suite in suites if isinstance(suite, dict) and suite.get("id") == suite_id]
    if len(matches) != 1:
        raise PreparationError("campaign suite identity is ambiguous")
    suite = matches[0]
    ledger_output = suite.get("outputRoot")
    if not isinstance(ledger_output, str):
        raise PreparationError("campaign suite output root is invalid")
    ledger_relative = Path(ledger_output)
    if ledger_relative.is_absolute() or ".." in ledger_relative.parts:
        raise PreparationError("campaign suite output root is unsafe")
    expected_root = output_root.parent.parent / ledger_relative
    if expected_root != output_root:
        raise PreparationError("prepared output root differs from the campaign ledger")
    if (
        suite.get("taskSetSha256") != metadata.get("taskSetSha256")
        or suite.get("casesPerArm") != metadata.get("populationPerArm")
        or suite.get("freshTrajectories") != metadata.get("expectedFreshTrajectories")
    ):
        raise PreparationError("prepared suite population differs from the campaign ledger")
    freshness = ledger.get("freshness")
    zero_reuse = {
        "captureInputs": [], "historicalResultInputs": [], "sourceRunRoots": [],
        "resume": False, "preseed": False, "reusedCases": 0,
    }
    if not isinstance(freshness, dict) or any(
        freshness.get(key) != value for key, value in zero_reuse.items()
    ):
        raise PreparationError("campaign ledger permits historical reuse")
    run_id = suite.get("runId")
    if not isinstance(run_id, str) or not run_id:
        raise PreparationError("campaign suite run ID is invalid")
    return {
        **metadata,
        "bridgeSuite": run_id,
        "campaignId": campaign_id,
        "runId": run_id,
        "suiteId": suite_id,
    }


def campaign_binding(metadata: Mapping[str, Any]) -> CampaignBinding:
    return {
        "formatVersion": 1,
        "campaignId": metadata["campaignId"],
        "suiteId": metadata["suiteId"],
        "runId": metadata["runId"],
        "arms": metadata["arms"],
        "taskSetSha256": metadata["taskSetSha256"],
        "runtimeFingerprintAggregateSha256": metadata["runtimeFingerprintAggregateSha256"],
        "expectedCasesPerArm": metadata["populationPerArm"],
        "expectedFreshTrajectories": metadata["expectedFreshTrajectories"],
        "resume": False, "preseed": False,
        "historicalCaptureInputs": [], "historicalResultInputs": [],
        "sourceRunRoots": [], "reusedCases": 0,
    }
