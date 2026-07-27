"""Trace-resource parsing helpers for autonomous outcome evaluation."""

import json
import pathlib
from typing import Any


def unavailable_resource_usage() -> dict[str, Any]:
    return {
        "measurement_status": "unavailable",
        "missing_measurements": [
            "agent_calls",
            "agent_duration_seconds",
            "input_tokens",
            "output_tokens",
        ],
    }


def trace_events(trace_path: pathlib.Path) -> list[dict[str, Any]] | None:
    try:
        events = [json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines() if line]
    except (OSError, json.JSONDecodeError):
        return None
    return events if all(isinstance(event, dict) for event in events) else None


def measured_resource_total(
    calls: list[dict[str, Any]], event_field: str, scale: float
) -> float | None:
    values = [event.get(event_field) for event in calls]
    if not calls or not all(isinstance(value, int) and value >= 0 for value in values):
        return None
    return round(sum(value for value in values if isinstance(value, int)) * scale, 4)
