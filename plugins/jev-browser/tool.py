"""browser_goal tool: schema, description and the Hermes handler around GoalRunner."""

from __future__ import annotations

import json
from typing import Callable

NEXT_DONE = "verify the final page with the standard browser tools before trusting this result"
NEXT_FALLBACK = "continue manually from url with the standard browser tools"

DESCRIPTION = (
    "Use browser_goal first for multi-step web goals (search forms, filters, bookings): it drives "
    "a fresh browser tab from `url` towards `goal` and returns the final page. On anything but "
    "status `done`, or if verification fails, continue from `url` with the standard browser tools."
)

SCHEMA = {
    "name": "browser_goal",
    "description": DESCRIPTION,
    "parameters": {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "Start page URL (e.g. 'https://www.google.com/travel/flights?hl=en')"},
            "goal": {"type": "string", "description": "What to achieve on the page, with every concrete value (places, dates, counts)"},
        },
        "required": ["url", "goal"],
    },
}

CLOSE_DESCRIPTION = (
    "Close the browser tab left open by the last browser_goal run. Call it once you have finished "
    "reading or verifying that page; returns {\"closed\": true|false}."
)

CLOSE_SCHEMA = {
    "name": "browser_goal_close",
    "description": CLOSE_DESCRIPTION,
    "parameters": {"type": "object", "properties": {}},
}


def make_handler(runner) -> Callable[..., str]:
    # Hermes' registry calls handler(args, **kwargs) (task_id etc.); only the schema args matter.
    def handler(args: dict, **_kwargs) -> str:
        result = runner.run(args["url"], args["goal"]).to_dict()
        result["next"] = NEXT_DONE if result["status"] == "done" else NEXT_FALLBACK
        return json.dumps(result)

    handler.runner = runner
    return handler


def make_close_handler(runner) -> Callable[..., str]:
    def handler(_args: dict | None = None, **_kwargs) -> str:
        return json.dumps({"closed": runner.close_tab()})

    handler.runner = runner
    return handler
