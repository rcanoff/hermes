"""Environment-driven settings for the jev-browser plugin (no Hermes imports)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

AGENTS = ("standard", "jev")
DECISION_BACKENDS = ("llm", "typesafe")


@dataclass(frozen=True)
class Settings:
    agent: str = "standard"
    decision_backend: str = "llm"
    typesafe_api_key: str = ""
    typesafe_model: str = "jev-latest"
    cdp_url: str = "http://host.docker.internal:9221"
    timeout_s: float = 60
    max_stale: int = 8
    settle_ms: int = 100
    max_repeat: int = 3

    @property
    def jev_enabled(self) -> bool:
        return self.agent == "jev"


def load(env: Mapping[str, str]) -> Settings:
    defaults = Settings()
    agent = (env.get("HERMES_BROWSER_AGENT") or defaults.agent).strip().lower()
    if agent not in AGENTS:
        raise ValueError(f"HERMES_BROWSER_AGENT must be one of {AGENTS}, got {agent!r}")
    if agent != "jev":
        return Settings(agent=agent)
    backend = (env.get("JEV_BROWSER_DECISION_BACKEND") or defaults.decision_backend).strip().lower()
    if backend not in DECISION_BACKENDS:
        raise ValueError(
            f"JEV_BROWSER_DECISION_BACKEND must be one of {DECISION_BACKENDS}, got {backend!r}"
        )
    api_key = env.get("TYPESAFE_API_KEY") or ""
    if backend == "typesafe" and not api_key:
        raise ValueError("TYPESAFE_API_KEY is required for JEV_BROWSER_DECISION_BACKEND=typesafe")
    return Settings(
        agent=agent,
        decision_backend=backend,
        typesafe_api_key=api_key,
        typesafe_model=env.get("TYPESAFE_MODEL") or defaults.typesafe_model,
        cdp_url=env.get("JEV_BROWSER_CDP_URL") or defaults.cdp_url,
        timeout_s=float(env.get("JEV_BROWSER_TIMEOUT_S") or defaults.timeout_s),
        max_stale=int(env.get("JEV_BROWSER_MAX_STALE") or defaults.max_stale),
        settle_ms=int(env.get("JEV_BROWSER_SETTLE_MS") or defaults.settle_ms),
        max_repeat=int(env.get("JEV_BROWSER_MAX_REPEAT") or defaults.max_repeat),
    )
