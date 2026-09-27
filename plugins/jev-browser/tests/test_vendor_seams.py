import pytest

from vendor import agent as agent_mod
from vendor import browser as browser_mod
from vendor.model import choose, field_text


class FakeClient:
    def __init__(self):
        self.calls = []

    def call(self, method, session_id=None, **params):
        self.calls.append((method, session_id, params))
        if method == "Target.createTarget":
            return {"targetId": "T1"}
        if method == "Target.attachToTarget":
            return {"sessionId": "S1"}
        if method == "Runtime.evaluate":
            return {"result": {"value": "complete"}}
        return {}


class FakeBackend:
    def __init__(self, answers):
        self.answers = answers
        self.bodies = []

    def decide(self, body):
        self.bodies.append(body)
        return {"answers": self.answers, "model": "fake"}


ACTION = {"id": "e1", "kind": "click", "label": "Search", "node": 1}
PAGE = {
    "fingerprint": "fp",
    "marker": "m",
    "url": "https://example.com/",
    "title": "Example",
    "text": "hello",
    "actions": [ACTION],
    "scroll": 0,
}


@pytest.fixture
def fake_client():
    return FakeClient()


def test_browser_uses_injected_client(fake_client):
    b = browser_mod.Browser("about:blank", fake_client)
    methods = [c[0] for c in fake_client.calls]
    assert methods[:2] == ["Target.createTarget", "Target.attachToTarget"]
    assert b.target == "T1" and b.session == "S1"
    assert ("Page.navigate", "S1", {"url": "about:blank"}) in fake_client.calls
    b.close()
    assert fake_client.calls[-1] == ("Target.closeTarget", None, {"targetId": "T1"})
    assert b.target is None


def test_choose_uses_backend_and_keeps_output_shape():
    answers = {
        "operation": {"choice": "CLICK", "confidence": 0.9, "probabilities": {"CLICK": 0.9, "DONE": 0.05, "BLOCKED": 0.05}},
        "click_target": {"choice": "1", "confidence": 1.0, "probabilities": {"1": 1.0}},
    }
    backend = FakeBackend(answers)
    result = choose(PAGE, "goal", [], backend)
    assert backend.bodies[0]["model"] == "jev-latest"
    assert result["choice"] == "e1"
    assert result["operation_probabilities"] == answers["operation"]["probabilities"]
    assert result["model"] == "fake"


def test_field_text_uses_text_fn():
    helper = {"model": "m", "latency_ms": 1}
    assert field_text({"goal": "g"}, lambda c: ("London", helper)) == ("London", helper)


def test_agent_threads_dependencies(fake_client, monkeypatch):
    monkeypatch.setattr(browser_mod.Browser, "observe", lambda self, screenshot=True: dict(PAGE))
    monkeypatch.setattr(browser_mod.Browser, "fresh", lambda self, page, action=None: True)
    backend = FakeBackend(
        {"operation": {"choice": "DONE", "confidence": 1.0, "probabilities": {"CLICK": 0.0, "DONE": 1.0, "BLOCKED": 0.0}}}
    )
    a = agent_mod.Agent("about:blank", "goal", client=fake_client, backend=backend, text_fn=lambda c: ("x", {}))
    list(a.run())
    assert a.state["status"] == "done"
    assert backend.bodies
    a.close()
