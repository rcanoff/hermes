from settings import load


def test_default_is_standard_and_disabled():
    s = load({})
    assert s.agent == "standard" and s.jev_enabled is False


def test_jev_enabled_with_defaults():
    s = load({"HERMES_BROWSER_AGENT": "jev"})
    assert s.jev_enabled and s.decision_backend == "llm"
    assert s.cdp_url == "http://host.docker.internal:9221" and s.timeout_s == 60 and s.max_stale == 8
    assert s.settle_ms == 100 and s.max_repeat == 3


def test_settle_and_repeat_overrides():
    s = load({"HERMES_BROWSER_AGENT": "jev", "JEV_BROWSER_SETTLE_MS": "250", "JEV_BROWSER_MAX_REPEAT": "5"})
    assert s.settle_ms == 250 and s.max_repeat == 5


def test_typesafe_backend_requires_key():
    import pytest
    with pytest.raises(ValueError, match="TYPESAFE_API_KEY"):
        load({"HERMES_BROWSER_AGENT": "jev", "JEV_BROWSER_DECISION_BACKEND": "typesafe"})


def test_unknown_values_rejected():
    import pytest
    with pytest.raises(ValueError):
        load({"HERMES_BROWSER_AGENT": "kev"})
    with pytest.raises(ValueError, match="JEV_BROWSER_DECISION_BACKEND"):
        load({"HERMES_BROWSER_AGENT": "jev", "JEV_BROWSER_DECISION_BACKEND": "gpt"})


def test_standard_skips_jev_validation():
    s = load({"HERMES_BROWSER_AGENT": "standard", "JEV_BROWSER_DECISION_BACKEND": "typesafe"})
    assert s.jev_enabled is False
