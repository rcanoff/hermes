"""Runs one browser goal through the vendored jev-ultrafast loop with caps and tab lifecycle."""

from __future__ import annotations

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


class GoalRunner:
    def __init__(
        self,
        *,
        cdp_url: str,
        backend,
        text_fn,
        timeout_s: float,
        max_stale: int,
        agent_factory=Agent,
        client_factory=CdpClient,
    ) -> None:
        self.cdp_url = cdp_url
        self.backend = backend
        self.text_fn = text_fn
        self.timeout_s = timeout_s
        self.max_stale = max_stale
        self.agent_factory = agent_factory
        self.client_factory = client_factory
        self._last_target: str | None = None

    def run(self, url: str, goal: str) -> GoalResult:
        started = time.monotonic()
        agent = None
        status, reason = "failed", None
        client = self.client_factory(self.cdp_url)
        try:
            client.connect()
            self._close_previous_tab(client)
            agent = self.agent_factory(
                url, goal, client=client, backend=self.backend, text_fn=self.text_fn
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
        finally:
            client.close()
        return self._result(agent, url, status, reason, started)

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
