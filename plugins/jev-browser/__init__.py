"""Hermes jev-browser plugin: browser_goal tool backed by jev-ultrafast."""

from __future__ import annotations

import logging
import os

logger = logging.getLogger("jev-browser")

_AUX_DEFAULTS = {"provider": "xai-oauth", "model": "grok-4.20-0309-non-reasoning", "timeout": 30}


def register(ctx) -> None:
    # Lazy: pytest's Package collector imports this file as a bare module (setup), so no module-level relative imports.
    if __package__:  # loaded by Hermes as the plugin package
        from . import settings, tool
        from .decision import LlmBackend, TypeSafeBackend, make_text_fn
        from .runner import GoalRunner
    else:  # loaded as a plain module (tests put the plugin dir on sys.path)
        import settings
        import tool
        from decision import LlmBackend, TypeSafeBackend, make_text_fn
        from runner import GoalRunner

    s = settings.load(os.environ)
    if not s.jev_enabled:
        logger.info("HERMES_BROWSER_AGENT=%s, tool not registered", s.agent)
        return
    ctx.register_auxiliary_task(
        "jev_browser_decide",
        display_name="Jev browser: decision",
        description="Picks the next browser action for browser_goal",
        defaults=dict(_AUX_DEFAULTS),
    )
    ctx.register_auxiliary_task(
        "jev_browser_text",
        display_name="Jev browser: text",
        description="Writes the text browser_goal types into form fields",
        defaults=dict(_AUX_DEFAULTS),
    )
    if s.decision_backend == "typesafe":
        backend = TypeSafeBackend(s.typesafe_api_key, s.typesafe_model)
    else:
        backend = LlmBackend(ctx.llm, task="jev_browser_decide")
    runner = GoalRunner(
        cdp_url=s.cdp_url,
        backend=backend,
        text_fn=make_text_fn(ctx.llm, task="jev_browser_text"),
        timeout_s=s.timeout_s,
        max_stale=s.max_stale,
        settle_ms=s.settle_ms,
        max_repeat=s.max_repeat,
    )
    ctx.register_tool(
        "browser_goal", "jev_browser", tool.SCHEMA, tool.make_handler(runner),
        description=tool.DESCRIPTION, emoji="⚡",
    )
    logger.info("browser_goal registered (decision backend %s)", s.decision_backend)
