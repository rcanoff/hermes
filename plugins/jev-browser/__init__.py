"""Hermes jev-browser plugin: browser_goal tool backed by jev-ultrafast."""

from __future__ import annotations

import logging
import os

logger = logging.getLogger("jev-browser")


def register(ctx) -> None:
    # Lazy: pytest's Package collector imports this file as a bare module (setup), so no module-level relative imports.
    from . import settings

    s = settings.load(os.environ)
    if not s.jev_enabled:
        logger.info("jev-browser: HERMES_BROWSER_AGENT=%s, tool not registered", s.agent)
        return
    # Task 6 registers tool + aux tasks
