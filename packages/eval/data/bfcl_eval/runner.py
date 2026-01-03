import json
import os
import sys

# Ensure bfcl_eval package root is on sys.path
PACKAGE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PACKAGE_ROOT not in sys.path:
    sys.path.insert(0, PACKAGE_ROOT)

from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_utils import execute_multi_turn_func_call
from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_checker import multi_turn_checker


def _handle_execute(payload):
    results, _instances = execute_multi_turn_func_call(
        func_call_list=payload.get("func_call_list", []),
        initial_config=payload.get("initial_config", {}),
        involved_classes=payload.get("involved_classes", []),
        model_name=payload.get("model_name", "model"),
        test_entry_id=payload.get("test_entry_id", ""),
        long_context=bool(payload.get("long_context", False)),
        is_evaL_run=bool(payload.get("is_eval_run", False)),
    )
    return {"results": results}


def _handle_check(payload):
    result = multi_turn_checker(
        payload.get("model_results", []),
        payload.get("ground_truth", []),
        payload.get("test_entry", {}),
        payload.get("test_category", ""),
        payload.get("model_name", "model"),
    )
    return {"result": result}


def _handle_reset(payload):
    # Optional cleanup of cached instances in globals
    model_name = payload.get("model_name")
    test_entry_id = payload.get("test_entry_id")
    if model_name and test_entry_id:
        prefix = f"{model_name}_{test_entry_id}_"
        to_delete = [k for k in globals().keys() if k.startswith(prefix)]
        for k in to_delete:
            try:
                del globals()[k]
            except Exception:
                pass
    return {"reset": True}


HANDLERS = {
    "execute": _handle_execute,
    "check": _handle_check,
    "reset": _handle_reset,
}


def main():
    for line in sys.stdin:
        if not line:
            continue
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
            action = payload.get("action")
            handler = HANDLERS.get(action)
            if handler is None:
                response = {"error": f"unknown action: {action}"}
            else:
                response = handler(payload)
            response["id"] = payload.get("id")
        except Exception as e:
            response = {"id": payload.get("id") if 'payload' in locals() else None, "error": str(e)}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
