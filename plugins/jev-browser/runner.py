"""Runs one browser goal through the vendored jev-ultrafast loop with caps and tab lifecycle."""

from __future__ import annotations

import threading
import time
from dataclasses import asdict, dataclass

if __package__:  # loaded as part of the Hermes plugin package
    from .cdp import CdpClient, CdpError
    from .decision import DecisionError
    from .vendor.agent import Agent
else:  # loaded as a top-level module (tests put the plugin dir on sys.path)
    from cdp import CdpClient, CdpError
    from decision import DecisionError
    from vendor.agent import Agent

_STEP_KEYS = ("step", "operation", "action", "text", "page_changed")
_TERMINAL = {"done", "blocked"}


@dataclass
class GoalResult:
    status: str  # done | blocked | failed
    reason: str | None
    url: str
    title: str
    elapsed_ms: int
    steps: list[dict]

    def to_dict(self) -> dict:
        return asdict(self)


class _Stop(Exception):
    def __init__(self, status: str, reason: str) -> None:
        super().__init__(reason)
        self.status = status
        self.reason = reason


class _RecordingClient:
    """Forwards CDP calls; records a created tab so it is closed even if Agent construction fails."""

    def __init__(self, client, runner) -> None:
        self._client = client
        self._runner = runner

    def call(self, method, *args, **params):
        result = self._client.call(method, *args, **params)
        if method == "Target.createTarget":
            self._runner._last_target = result["targetId"]
        return result


class GoalRunner:
    def __init__(
        self,
        *,
        cdp_url: str,
        backend,
        text_fn,
        timeout_s: float,
        max_stale: int,
        settle_ms: int = 0,
        max_repeat: int = 3,
        agent_factory=Agent,
        client_factory=CdpClient,
    ) -> None:
        self.cdp_url = cdp_url
        self.backend = backend
        self.text_fn = text_fn
        self.timeout_s = timeout_s
        self.max_stale = max_stale
        self.settle_ms = settle_ms
        self.max_repeat = max_repeat
        self.agent_factory = agent_factory
        self.client_factory = client_factory
        self._last_target: str | None = None
        self._lock = threading.Lock()

    def run(self, url: str, goal: str) -> GoalResult:
        # One runner is shared across gateway threads; overlapping runs would close each other's tabs.
        with self._lock:
            return self._run(url, goal)

    def _run(self, url: str, goal: str) -> GoalResult:
        started = time.monotonic()
        agent = None
        status, reason = "failed", None
        client = self.client_factory(self.cdp_url)
        try:
            client.connect()
            self._close_previous_tab(client)
            agent = self.agent_factory(
                url,
                goal,
                client=_RecordingClient(client, self),
                backend=self.backend,
                text_fn=self.text_fn,
                settle_ms=self.settle_ms,
            )
            self._last_target = agent.browser.target
            status, reason = self._drive(agent, started)
        except _Stop as stop:
            status, reason = stop.status, stop.reason
        except ValueError as exc:
            # StalePage is swallowed by the tick; remaining ValueErrors are budgets or misuse.
            if "budget" in str(exc):
                status, reason = "blocked", "step budget reached"
            else:
                reason = str(exc)
        except (CdpError, DecisionError, RuntimeError) as exc:
            reason = str(exc)
        except Exception as exc:
            reason = f"{type(exc).__name__}: {exc}"
        finally:
            client.close()
        return self._result(agent, url, status, reason, started)

    def close_tab(self) -> bool:
        """Close the tab left open by the last run. True if a tab was closed."""
        with self._lock:
            if self._last_target is None:
                return False
            client = self.client_factory(self.cdp_url)
            try:
                client.connect()
                self._close_previous_tab(client)
            except CdpError:
                return False
            finally:
                client.close()
            return True

    def _close_previous_tab(self, client) -> None:
        target, self._last_target = self._last_target, None
        if target is None:
            return
        try:
            client.call("Target.closeTarget", targetId=target)
        except CdpError:
            pass  # already gone (daemon restart, user closed it)

    def _drive(self, agent, started: float) -> tuple[str, str | None]:
        ticks = agent.run()
        stale = 0
        seen = len(agent.state["history"])
        # Terminal state wins over the clock: a final tick that crosses timeout_s keeps its outcome.
        while agent.state["status"] not in _TERMINAL:
            if time.monotonic() - started > self.timeout_s:
                raise _Stop("failed", f"timeout {self.timeout_s}s")
            next(ticks)
            state = agent.state
            if len(state["history"]) > seen:
                seen, stale = len(state["history"]), 0
                if self._repeating(state["history"]):
                    raise _Stop("blocked", f"repeated action {self.max_repeat} times")
            elif state["status"] == "ready":
                stale += 1
                if stale > self.max_stale:
                    raise _Stop("failed", "page kept changing")
        state = agent.state
        if state["status"] == "done":
            return "done", None
        decisions = state["decisions"]
        if decisions and decisions[-1].get("choice") == "BLOCKED":
            return "blocked", "model chose BLOCKED"
        return "blocked", "no page change in 3 actions"

    def _repeating(self, history: list) -> bool:
        """True when the last max_repeat actions are the same operation on the same target with the same text."""
        tail = history[-self.max_repeat :]
        if len(tail) < self.max_repeat:
            return False
        keys = {(h.get("operation"), h.get("action"), h.get("text")) for h in tail}
        return len(keys) == 1

    def _result(self, agent, url, status, reason, started) -> GoalResult:
        # One clock for every path: covers connect, Agent construction and the last tick.
        elapsed_ms = round((time.monotonic() - started) * 1000)
        if agent is None:
            return GoalResult(status, reason, url, "", elapsed_ms, [])
        state = agent.state
        page = state["page"]
        return GoalResult(
            status=status,
            reason=reason,
            url=page.get("url", url),
            title=page.get("title", ""),
            elapsed_ms=elapsed_ms,
            steps=[{key: entry.get(key) for key in _STEP_KEYS} for entry in state["history"]],
        )
