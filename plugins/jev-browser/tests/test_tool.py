import importlib.util
import json
from pathlib import Path

import pytest

from decision import LlmBackend, TypeSafeBackend
from runner import GoalResult

PLUGIN_DIR = Path(__file__).resolve().parent.parent
URL = "https://www.google.com/travel/flights?hl=en"
GOAL = "one-way Zurich to London"
STEP = {"step": 1, "operation": "TYPE_TEXT", "action": "combobox Where to?", "text": "London", "page_changed": True}


class FakeRunner:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def run(self, url, goal):
        self.calls.append((url, goal))
        return self.result


@pytest.fixture
def fake_runner_done():
    return FakeRunner(GoalResult("done", None, URL + "#results", "Flights", 7100, [STEP]))


@pytest.fixture
def fake_runner_failed():
    return FakeRunner(GoalResult("failed", "timeout 60s", URL, "Google Flights", 60012, []))


class FakeCtx:
    def __init__(self):
        self.llm = object()
        self.tools = {}
        self.aux = {}

    def register_tool(self, name, toolset, schema, handler, **kwargs):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, **kwargs}

    def register_auxiliary_task(self, key, *, display_name, description, defaults=None):
        self.aux[key] = {"display_name": display_name, "description": description, "defaults": defaults}


@pytest.fixture
def fake_ctx():
    return FakeCtx()


@pytest.fixture
def plugin():
    # Load __init__.py as a plain module (not a package) so it resolves the same top-level modules as the tests.
    spec = importlib.util.spec_from_file_location(
        "jev_browser_plugin", PLUGIN_DIR / "__init__.py", submodule_search_locations=None
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for key in ("HERMES_BROWSER_AGENT", "JEV_BROWSER_DECISION_BACKEND", "TYPESAFE_API_KEY"):
        monkeypatch.delenv(key, raising=False)


def test_handler_serializes_done_with_verify_hint(fake_runner_done):
    import tool

    out = json.loads(tool.make_handler(fake_runner_done)({"url": URL, "goal": GOAL}, task_id="t1"))

    assert fake_runner_done.calls == [(URL, GOAL)]
    assert out == {
        "status": "done",
        "reason": None,
        "url": URL + "#results",
        "title": "Flights",
        "elapsed_ms": 7100,
        "steps": [STEP],
        "next": "verify the final page with the standard browser tools before trusting this result",
    }


def test_handler_serializes_failed_with_manual_hint(fake_runner_failed):
    import tool

    out = json.loads(tool.make_handler(fake_runner_failed)({"url": URL, "goal": GOAL}))

    assert out["status"] == "failed"
    assert out["reason"] == "timeout 60s"
    assert out["url"] == URL
    assert out["next"] == "continue manually from url with the standard browser tools"


def test_register_skips_when_standard(fake_ctx, plugin):
    plugin.register(fake_ctx)

    assert fake_ctx.tools == {}
    assert fake_ctx.aux == {}


def test_register_registers_tool_and_two_aux_tasks(fake_ctx, plugin, monkeypatch):
    import tool

    monkeypatch.setenv("HERMES_BROWSER_AGENT", "jev")

    plugin.register(fake_ctx)

    entry = fake_ctx.tools["browser_goal"]
    assert entry["toolset"] == "jev_browser"
    assert entry["schema"] == tool.SCHEMA
    assert entry["schema"]["parameters"]["required"] == ["url", "goal"]
    assert set(fake_ctx.aux) == {"jev_browser_decide", "jev_browser_text"}
    assert isinstance(entry["handler"].runner.backend, LlmBackend)


def test_register_typesafe_backend_selected(fake_ctx, plugin, monkeypatch):
    monkeypatch.setenv("HERMES_BROWSER_AGENT", "jev")
    monkeypatch.setenv("JEV_BROWSER_DECISION_BACKEND", "typesafe")
    monkeypatch.setenv("TYPESAFE_API_KEY", "test-key")

    plugin.register(fake_ctx)

    assert isinstance(fake_ctx.tools["browser_goal"]["handler"].runner.backend, TypeSafeBackend)
