import time

from cdp import CdpError
from runner import GoalResult, GoalRunner


class FakeClient:
    def __init__(self, cdp_url, *, fail_connect=False):
        self.cdp_url = cdp_url
        self.fail_connect = fail_connect
        self.calls = []
        self.closed = False

    def connect(self):
        if self.fail_connect:
            raise CdpError("GET http://daemon/json/version failed: refused")

    def call(self, method, session_id=None, **params):
        self.calls.append((method, params))
        return {}

    def close(self):
        self.closed = True


class ClientFactory:
    def __init__(self, fail_connect=False):
        self.fail_connect = fail_connect
        self.clients = []

    def __call__(self, cdp_url):
        client = FakeClient(cdp_url, fail_connect=self.fail_connect)
        self.clients.append(client)
        return client


class FakeBrowser:
    def __init__(self, target):
        self.target = target
        self.closed = False

    def close(self):
        self.closed = True


def history_entry(n, *, page_changed=True):
    return {
        "step": n,
        "action": f"click #{n}",
        "kind": "click",
        "choice": f"a{n}",
        "operation": "click",
        "target": "button",
        "text": None,
        "page_changed": page_changed,
        "url": "https://example.test/next",
        "latency_ms": 12,
    }


class FakeAgent:
    """Replays `ticks`: each is a callable mutating state (may sleep or raise)."""

    def __init__(self, target, ticks, *, forever=None):
        self.browser = FakeBrowser(target)
        self.ticks = list(ticks)
        self.forever = forever
        self.state = {
            "status": "ready",
            "history": [],
            "decisions": [],
            "decision": None,
            "page": {"url": "https://example.test/", "title": "Example"},
            "elapsed_ms": 0,
        }

    def run(self):
        while self.state["status"] not in {"done", "blocked"}:
            if self.ticks:
                self.ticks.pop(0)(self.state)
            elif self.forever:
                self.forever(self.state)
            else:
                raise AssertionError("fake agent ran out of ticks")
            yield dict(self.state)


class AgentFactory:
    def __init__(self, make):
        self.make = make
        self.calls = []

    def __call__(self, url, goal, *, client, backend, text_fn):
        self.calls.append((url, goal, client))
        return self.make(len(self.calls))


def act(state):
    state["history"].append(history_entry(len(state["history"]) + 1))
    state["page"] = {"url": "https://example.test/next", "title": "Next page"}
    state["decisions"].append({"choice": f"a{len(state['history'])}"})
    state["elapsed_ms"] += 100


def decide(choice, status):
    def tick(state):
        state["decisions"].append({"choice": choice})
        state["status"] = status
        state["elapsed_ms"] += 50

    return tick


def make_runner(agent_factory, client_factory=None, **overrides):
    kwargs = dict(
        cdp_url="http://daemon:9222",
        backend=object(),
        text_fn=lambda context: "",
        timeout_s=5,
        max_stale=3,
        agent_factory=agent_factory,
        client_factory=client_factory or ClientFactory(),
    )
    kwargs.update(overrides)
    return GoalRunner(**kwargs)


def test_done_result_has_url_title_steps():
    clients = ClientFactory()
    runner = make_runner(AgentFactory(lambda n: FakeAgent("T1", [act, act, decide("DONE", "done")])), clients)

    result = runner.run("https://example.test/", "find the next page")

    assert isinstance(result, GoalResult)
    assert result.status == "done"
    assert result.reason is None
    assert result.url == "https://example.test/next"
    assert result.title == "Next page"
    assert 0 <= result.elapsed_ms < 250  # runner's clock, not the agent's own counter (250)
    assert result.steps == [
        {"step": 1, "operation": "click", "action": "click #1", "text": None, "page_changed": True},
        {"step": 2, "operation": "click", "action": "click #2", "text": None, "page_changed": True},
    ]
    assert result.to_dict()["steps"] == result.steps
    assert result.to_dict()["status"] == "done"
    client = clients.clients[0]
    assert client.closed
    assert ("Target.closeTarget", {"targetId": "T1"}) not in client.calls


def test_blocked_reason_from_model_choice():
    runner = make_runner(AgentFactory(lambda n: FakeAgent("T1", [act, decide("BLOCKED", "blocked")])))

    result = runner.run("https://example.test/", "log in")

    assert result.status == "blocked"
    assert result.reason == "model chose BLOCKED"
    assert len(result.steps) == 1


def test_blocked_reason_no_page_change_and_step_budget():
    def unchanged(state):
        act(state)
        state["history"][-1]["page_changed"] = False
        if len(state["history"]) == 3:
            state["status"] = "blocked"

    result = make_runner(AgentFactory(lambda n: FakeAgent("T1", [unchanged] * 3))).run("u", "g")
    assert (result.status, result.reason) == ("blocked", "no page change in 3 actions")

    def budget(state):
        state["status"] = "blocked"
        raise ValueError("Stopped at the 60-action demo budget")

    result = make_runner(AgentFactory(lambda n: FakeAgent("T1", [act, budget]))).run("u", "g")
    assert (result.status, result.reason) == ("blocked", "step budget reached")
    assert len(result.steps) == 1


def test_timeout_marks_failed_with_reason():
    def slow(state):
        time.sleep(0.03)
        act(state)

    clients = ClientFactory()
    runner = make_runner(AgentFactory(lambda n: FakeAgent("T1", [], forever=slow)), clients, timeout_s=0.05)

    result = runner.run("https://example.test/", "never finishes")

    assert result.status == "failed"
    assert result.reason == "timeout 0.05s"
    assert 1 <= len(result.steps) <= 3
    assert clients.clients[0].closed


def test_final_tick_crossing_timeout_keeps_done():
    def slow_done(state):
        time.sleep(0.1)
        decide("DONE", "done")(state)

    runner = make_runner(AgentFactory(lambda n: FakeAgent("T1", [slow_done])), timeout_s=0.05)

    result = runner.run("https://example.test/", "finishes late")

    assert (result.status, result.reason) == ("done", None)
    assert result.elapsed_ms >= 100  # runner's clock covers the last tick


def test_stale_loop_stops_at_max_stale():
    ticks = []

    def stale(state):
        ticks.append(1)
        state["status"] = "ready"
        state["decision"] = None

    runner = make_runner(AgentFactory(lambda n: FakeAgent("T1", [stale, act], forever=stale)), max_stale=3)

    result = runner.run("https://example.test/", "moving page")

    assert result.status == "failed"
    assert result.reason == "page kept changing"
    # one stale tick, one real action (resets the counter), then max_stale + 1 stale ticks
    assert len(ticks) == 1 + 3 + 1
    assert len(result.steps) == 1


def test_errors_are_failed_with_message():
    def boom(state):
        raise RuntimeError("dropdown value was not confirmed")

    result = make_runner(AgentFactory(lambda n: FakeAgent("T1", [act, boom]))).run("u", "g")

    assert (result.status, result.reason) == ("failed", "dropdown value was not confirmed")
    assert len(result.steps) == 1


def test_cdp_error_during_connect_is_failed_and_records_no_tab():
    clients = ClientFactory(fail_connect=True)
    agents = AgentFactory(lambda n: FakeAgent(f"T{n}", [decide("DONE", "done")]))
    runner = make_runner(agents, clients)

    result = runner.run("https://example.test/", "anything")

    assert result.status == "failed"
    assert result.reason == "GET http://daemon/json/version failed: refused"
    assert result.url == "https://example.test/"
    assert result.steps == []
    assert agents.calls == []
    assert clients.clients[0].closed

    clients.fail_connect = False
    runner.run("https://example.test/", "anything")
    assert not any(method == "Target.closeTarget" for method, _ in clients.clients[1].calls)


def test_cdp_error_during_agent_construction_closes_previous_and_records_no_tab():
    clients = ClientFactory()

    def make(n):
        if n == 2:
            raise CdpError("Target.createTarget failed: ConnectionClosed")
        return FakeAgent(f"T{n}", [decide("DONE", "done")])

    runner = make_runner(AgentFactory(make), clients)

    assert runner.run("https://example.test/", "first").status == "done"
    result = runner.run("https://example.test/", "second")

    assert clients.clients[1].calls == [("Target.closeTarget", {"targetId": "T1"})]
    assert (result.status, result.reason) == ("failed", "Target.createTarget failed: ConnectionClosed")
    assert result.steps == []
    assert clients.clients[1].closed

    runner.run("https://example.test/", "third")
    assert not any(method == "Target.closeTarget" for method, _ in clients.clients[2].calls)


def test_second_run_closes_previous_tab(monkeypatch):
    clients = ClientFactory()
    agents = AgentFactory(lambda n: FakeAgent(f"T{n}", [decide("DONE", "done")]))
    runner = make_runner(agents, clients)

    runner.run("https://example.test/", "first")
    assert clients.clients[0].calls == []  # first tab stays open
    runner.run("https://example.test/", "second")

    assert clients.clients[1].calls == [("Target.closeTarget", {"targetId": "T1"})]
    assert agents.calls[1][2] is clients.clients[1]
    assert all(c.closed for c in clients.clients)

    def failing_close(self, method, session_id=None, **params):
        raise CdpError("No target with given id found")

    monkeypatch.setattr(FakeClient, "call", failing_close)
    result = runner.run("https://example.test/", "third")
    assert result.status == "done"
